import { randomUUID } from "node:crypto";
import { classifyBlueprint, parseBlueprint } from "./blueprints.ts";
import { RepositoryError, type RepositoryIndex } from "./types.ts";

export function parseRepositoryUrl(input: string) {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new RepositoryError("Paste a GitHub repository URL, such as https://github.com/owner/repository.", "INVALID_REPOSITORY_URL"); }
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || parts.length < 2 || parts.length > 2 && (parts[2] !== "tree" || parts.length < 4)) throw new RepositoryError("Use a github.com repository URL or a /tree/branch URL.", "INVALID_REPOSITORY_URL");
  const [owner, rawName] = parts;
  const name = rawName.replace(/\.git$/, "");
  if (![owner, name].every(value => /^[\w.-]+$/.test(value) && !/^\.+$/.test(value))) throw new RepositoryError("The repository URL is invalid.", "INVALID_REPOSITORY_URL");
  return { owner, name, ref: parts.slice(3).join("/") || undefined, url: "https://github.com/" + owner + "/" + name };
}

type TreeEntry = { path: string; sha: string; type: string; mode: string; size?: number };
type Tree = { tree: TreeEntry[]; truncated: boolean };
type Options = { token?: string; signal?: AbortSignal; ownerKey: string; onStatus?: (message: string) => void; fetcher?: typeof fetch };

export async function ingestRepository(input: string, options: Options): Promise<RepositoryIndex> {
  const repo = parseRepositoryUrl(input);
  const fetcher = options.fetcher ?? fetch;
  let calls = 0;
  const api = async <T>(path: string): Promise<T> => {
    if (++calls > 180) throw new RepositoryError("This repository exceeded the scan request limit. Narrow the repository or try a smaller architectural snapshot.", "REPOSITORY_LIMIT");
    options.signal?.throwIfAborted();
    const response = await fetcher("https://api.github.com/repos/" + encodeURIComponent(repo.owner) + "/" + encodeURIComponent(repo.name) + path, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(options.token ? { Authorization: "Bearer " + options.token } : {}) },
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
      redirect: "error", cache: "no-store",
    });
    if (!response.ok) {
      if (response.status === 404) throw new RepositoryError("Repository or branch not found. For a private repository, connect a GitHub token with read access in Repository access.", "REPOSITORY_NOT_FOUND");
      if (response.status === 401) throw new RepositoryError("GitHub rejected your token. Update it in Repository access.", "GITHUB_AUTH");
      if (response.status === 403 || response.status === 429) throw new RepositoryError("GitHub denied this request or its rate limit was reached. Check repository access, connect a token, or retry after the limit resets.", "GITHUB_LIMIT", true);
      throw new RepositoryError("GitHub could not complete the scan. Please retry.", "GITHUB_UNAVAILABLE", true);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new RepositoryError("GitHub returned an empty response.");
    const buffers: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 12_000_000) { await reader.cancel(); throw new RepositoryError("The repository listing exceeds the scan size limit.", "REPOSITORY_LIMIT"); }
      buffers.push(value);
    }
    return JSON.parse(Buffer.concat(buffers).toString("utf8")) as T;
  };
  options.onStatus?.("Discovering blueprint files on GitHub");
  const metadata = await api<{ default_branch: string }>("");
  const commit = await api<{ sha: string; commit: { tree: { sha: string } } }>("/commits/" + encodeURIComponent(repo.ref ?? metadata.default_branch));
  if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new RepositoryError("GitHub did not return a valid repository revision.");
  const root = await api<Tree>("/git/trees/" + commit.commit.tree.sha + "?recursive=1");
  let entries = root.tree;
  if (root.truncated) {
    entries = [];
    const queue = [{ sha: commit.commit.tree.sha, prefix: "" }];
    while (queue.length) {
      const item = queue.shift()!;
      const subtree = await api<Tree>("/git/trees/" + item.sha);
      if (subtree.truncated) throw new RepositoryError("GitHub could not provide a complete directory listing.", "REPOSITORY_LIMIT");
      for (const entry of subtree.tree) {
        const full = { ...entry, path: item.prefix + entry.path };
        if (full.type === "tree" && !/(^|\/)(node_modules|vendor|dist|\.git|\.terraform)(\/|$)/.test(full.path)) queue.push({ sha: full.sha, prefix: full.path + "/" });
        else entries.push(full);
      }
      if (entries.length > 100000) throw new RepositoryError("Repository exceeds the supported file count.", "REPOSITORY_LIMIT");
    }
  }
  const candidates = entries.filter(e => e.type === "blob" && e.mode !== "120000" && classifyBlueprint(e.path));
  const priority = (e: TreeEntry) => ({ documentation: 0, compose: 1, terraform: 2, dependencies: 3, docker: 4, cloudformation: 5, kubernetes: 6, yaml: 7 }[classifyBlueprint(e.path)!]);
  candidates.sort((a, b) => priority(a) - priority(b) || a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
  const index: RepositoryIndex = { version: 1, id: randomUUID(), ownerKey: options.ownerKey, repository: { ...repo, commit: commit.sha }, createdAt: new Date().toISOString(), discoveredFiles: candidates.length, files: [], evidence: [], warnings: [] };
  if (candidates.length > 120) index.warnings.push("Found " + candidates.length + " candidate files; scanned the first 120 by blueprint priority. This overview is partial.");
  let totalBytes = 0;
  for (const [i, file] of candidates.slice(0, 120).entries()) {
    options.signal?.throwIfAborted();
    if (!file.size || file.size > 128000) { index.warnings.push(file.path + ": skipped empty or oversized file (128 KB per-file limit)."); continue; }
    if (totalBytes + file.size > 1800000 || index.evidence.length > 1500) { index.warnings.push("Reached the evidence size limit. Some blueprints were not indexed."); break; }
    options.onStatus?.("Reading blueprint " + (i + 1) + "/" + Math.min(120, candidates.length) + " · " + file.path);
    const blob = await api<{ encoding: string; content: string; size: number }>("/git/blobs/" + file.sha);
    if (blob.encoding !== "base64" || blob.size > 128000 || blob.content.length > 180000) { index.warnings.push(file.path + ": unsupported or oversized content."); continue; }
    const raw = Buffer.from(blob.content, "base64").toString("utf8");
    totalBytes += Buffer.byteLength(raw);
    const parsed = parseBlueprint(file.path, raw);
    index.warnings.push(...parsed.warnings);
    if (!parsed.evidence.length) continue;
    index.files.push({ path: file.path, kind: parsed.kind, bytes: blob.size });
    for (const item of parsed.evidence) index.evidence.push({ ...item, id: "e" + (index.evidence.length + 1) });
  }
  index.warnings = index.warnings.slice(0, 100);
  if (!index.evidence.length) throw new RepositoryError("No readable architecture blueprints were found. Chalkie looks for container files, infrastructure declarations, dependency manifests, and architecture documentation; application source code is excluded.", "NO_BLUEPRINTS");
  return index;
}

export function retrieveEvidence(index: RepositoryIndex, question: string, limit = 24) {
  const terms = new Set(question.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? []);
  const scored = index.evidence.map(item => {
    const text = (item.path + " " + item.text).toLowerCase();
    const score = [...terms].reduce((sum, term) => sum + (text.includes(term) ? 2 : 0), 0);
    return { item, score: score + (item.kind === "documentation" ? 0.15 : 0.1) };
  }).sort((a, b) => b.score - a.score);
  // Include structural evidence from each file class even when an overview has no keywords.
  const selected = new Map<string, RepositoryIndex["evidence"][number]>();
  for (const kind of ["documentation", "compose", "terraform", "kubernetes", "cloudformation", "dependencies", "docker"]) {
    const match = scored.find(row => row.item.kind === kind); if (match) selected.set(match.item.id, match.item);
  }
  for (const { item } of scored) { if (selected.size >= limit) break; selected.set(item.id, item); }
  let budget = 0;
  return [...selected.values()].filter(item => { budget += item.text.length; return budget <= 38000; });
}
