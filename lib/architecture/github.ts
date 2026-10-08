import { randomUUID } from "node:crypto";
import { RepositoryError, type RepositoryIndex } from "./types";
import { githubFailure } from "./github-errors";
import { ARCHIVE_BYTE_LIMIT, readPublicArchive, type PublicBlueprintSnapshot } from "./github-archive";
import { PublicSnapshotCache } from "./public-snapshot-cache";

export function parseRepositoryUrl(input: string) {
  const invalid = () => new RepositoryError("Use a public github.com repository URL or a /tree/branch URL.", "INVALID_REPOSITORY_URL");
  let url: URL, parts: string[];
  try {
    url = new URL(input.trim());
    parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean).map(decodeURIComponent);
  } catch { throw invalid(); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || parts.length < 2 || parts.length > 2 && (parts[2] !== "tree" || parts.length < 4)) throw invalid();
  const [owner, rawName] = parts;
  const name = rawName.replace(/\.git$/, "");
  if (![owner, name].every(value => /^[\w.-]+$/.test(value) && !/^\.+$/.test(value))) throw invalid();
  const ref = parts.slice(3).join("/") || undefined;
  if (ref && (ref.length > 250 || /[\x00-\x20\x7f~^:?*\[\\]/.test(ref) || ref.includes("..") || ref.split("/").some(part => !part || part === "."))) throw invalid();
  return { owner, name, ref, url: "https://github.com/" + owner + "/" + name };
}

type Options = { signal?: AbortSignal; ownerKey: string; allowEmptyEvidence?: boolean; onStatus?: (message: string) => void; fetcher?: typeof fetch; cache?: PublicSnapshotCache };
const publicCache = new PublicSnapshotCache();
let activeImports = 0;

async function readArchiveResponse(response: Response, signal: AbortSignal) {
  const declaredSize = Number(response.headers.get("content-length"));
  if (declaredSize > ARCHIVE_BYTE_LIMIT) {
    await response.body?.cancel();
    throw new RepositoryError("The repository snapshot exceeds the 32 MB compressed download limit.", "REPOSITORY_LIMIT");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RepositoryError("GitHub returned an empty archive. Please retry.", "GITHUB_INVALID_ARCHIVE", true);
  const buffers: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > ARCHIVE_BYTE_LIMIT) throw new RepositoryError("The repository snapshot exceeds the 32 MB compressed download limit.", "REPOSITORY_LIMIT");
      buffers.push(value);
    }
    return Buffer.concat(buffers, size);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
  }
}

/** Public archive import: no REST requests, credentials, model calls, or source execution. */
export async function ingestRepository(input: string, options: Options): Promise<RepositoryIndex> {
  const repo = parseRepositoryUrl(input);
  const signal = AbortSignal.any([AbortSignal.timeout(90000), ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  if (activeImports >= 2) throw new RepositoryError("Chalkie is importing other repositories. Please retry shortly.", "GITHUB_IMPORT_BUSY", true, Date.now() + 5000);
  activeImports++;
  // Injected fetchers use isolated caches unless a test explicitly supplies one.
  const cache = options.cache ?? (options.fetcher ? new PublicSnapshotCache() : publicCache);
  const url = "https://codeload.github.com/" + encodeURIComponent(repo.owner) + "/" + encodeURIComponent(repo.name) + "/zip/" + encodeURIComponent(repo.ref ?? "HEAD");
  const cached = cache.get(url);
  try {
    options.onStatus?.(cached ? "Checking the public repository for changes" : "Importing public GitHub snapshot · no GitHub token needed");
    const response = await (options.fetcher ?? fetch)(url, {
      headers: { Accept: "application/zip", ...(cached ? { "If-None-Match": cached.etag } : {}) },
      signal, credentials: "omit", redirect: "error", cache: "no-store",
    });
    let snapshot: PublicBlueprintSnapshot;
    if (response.status === 304 && cached) {
      signal.throwIfAborted();
      snapshot = cached.snapshot;
      options.onStatus?.("Reusing the unchanged public repository snapshot");
      cache.set(url, cached.etag, snapshot);
    } else {
      if (!response.ok) { cache.delete(url); throw await githubFailure(response); }
      const archive = await readArchiveResponse(response, signal);
      snapshot = await readPublicArchive(archive, repo, signal, options.onStatus, cached?.snapshot);
      cache.set(url, response.headers.get("etag") ?? "", snapshot);
    }
    const index: RepositoryIndex = { ...structuredClone(snapshot), version: 1, id: randomUUID(), ownerKey: options.ownerKey, createdAt: new Date().toISOString() };
    if (!index.evidence.length) {
      if (!options.allowEmptyEvidence) throw new RepositoryError("No readable architecture blueprints were found. Add supporting documentation, or use a public repository with container files, infrastructure declarations, dependency manifests, or architecture docs. Application source code is excluded.", "NO_BLUEPRINTS");
      index.warnings.push("No readable repository blueprints were found. This explanation relies on your supporting documentation; repository architecture is unverified.");
    }
    return index;
  } catch (error) {
    options.signal?.throwIfAborted();
    if (signal.aborted) throw new RepositoryError("The public repository download took too long. Retry or use a smaller repository.", "GITHUB_DOWNLOAD_TIMEOUT", true);
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError("Chalkie could not download the public repository snapshot. Check the repository URL and connection, then retry.", "GITHUB_UNAVAILABLE", true);
  } finally { activeImports--; }
}

export function retrieveEvidence(index: RepositoryIndex, question: string, limit = 24) {
  const stopWords = new Set(["the", "and", "this", "that", "with", "from", "what", "how", "its", "for", "through", "explain", "repository", "supported", "documented", "first", "when", "then", "their", "which", "does", "into", "about", "only"]);
  const terms = new Set((question.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? []).filter(term => !stopWords.has(term)));
  const scored = index.evidence.map(item => {
    const text = (item.path + " " + item.text).toLowerCase();
    const score = [...terms].reduce((sum, term) => sum + (text.includes(term) ? 2 : 0), 0);
    const introduction = item.startLine === 1 && /(?:^|\/)(?:readme|architecture)\.md$/i.test(item.path) ? 1 : 0;
    return { item, score: score + introduction + (item.kind === "documentation" ? 0.15 : 0.1) };
  }).sort((a, b) => b.score - a.score);
  // Include structural evidence from each file class even when an overview has no keywords.
  const selected = new Map<string, RepositoryIndex["evidence"][number]>();
  for (const kind of ["documentation", "compose", "terraform", "kubernetes", "cloudformation", "dependencies", "docker"]) {
    const match = scored.find(row => row.item.kind === kind && row.item.origin !== "attachment"); if (match) selected.set(match.item.id, match.item);
  }
  // Give supplementary documents representation without flooding the overview.
  const attachments = new Set<string>();
  for (const { item } of scored) if (item.origin === "attachment" && !attachments.has(item.path) && selected.size < limit) {
    selected.set(item.id, item); attachments.add(item.path);
  }
  for (const { item } of scored) { if (selected.size >= limit) break; selected.set(item.id, item); }
  let budget = 0;
  return [...selected.values()].filter(item => { if (budget + item.text.length > 38000) return false; budget += item.text.length; return true; });
}
