import { createHash } from "node:crypto";
import path from "node:path";
import { classifyBlueprint, parseBlueprint } from "./blueprints";
import { analyzeSource, classifySource, isSafeRepositoryPath } from "./source-analysis";
import { questionTerms, relevance, examplePenalty } from "./evidence-search";
import type { RepositoryIndex, RepositoryTreeEntry } from "./types";
import { ingestRepository } from "./github";

const FILE_LIMIT = 6;
const BYTE_LIMIT = 128000;
const MAX_EVIDENCE = 6000;
const MAX_EVIDENCE_CHARS = 7_000_000;
type Options = { signal?: AbortSignal; fetcher?: typeof fetch; onStatus?: (message: string) => void; freshlyIndexed?: boolean };

function localImports(index: RepositoryIndex, file: string): string[] {
  const entries = index.tree ?? [];
  const result: string[] = [];
  for (const imported of index.sourceFiles?.find(source => source.path === file)?.imports ?? []) {
    if (/https?:|^[a-z]:|\\|[\x00-\x1f]/i.test(imported)) continue;
    let relative: string | undefined;
    if (imported.startsWith(".")) {
      if (file.endsWith(".py")) {
        const dots = imported.match(/^\.+/)![0].length;
        const parent = [path.posix.dirname(file), ...Array.from({ length: dots - 1 }, () => "..")];
        relative = path.posix.normalize(path.posix.join(...parent, imported.slice(dots).replaceAll(".", "/")));
      } else relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), imported)).replace(/\.[cm]?[jt]sx?$/, "");
    }
    const modulePath = imported.replace(/^@\//, "").replace(/^\.+/, "").replaceAll(".", "/");
    for (const entry of entries) {
      const stem = entry.path.replace(/\.(?:[cm]?[jt]sx?|py)$/, "").replace(/\/(?:index|__init__)$/, "");
      if (relative ? stem === relative || entry.path === relative : modulePath && (stem === modulePath || stem.endsWith("/" + modulePath))) result.push(entry.path);
      if (result.length >= 24) return result;
    }
  }
  return [...new Set(result)];
}

export function researchCandidates(index: RepositoryIndex, question: string, refreshIndexed = true): RepositoryTreeEntry[] {
  const terms = questionTerms(question);
  const scores = new Map<string, number>();
  for (const source of index.evidence) if (source.origin !== "attachment") scores.set(source.path, Math.max(scores.get(source.path) ?? 0, relevance(source.text, terms)));
  const indexed = new Set(index.files.map(file => file.path));
  const symbols = new Map(index.sourceFiles?.map(file => [file.path, relevance(file.symbols.join(" "), terms)]));
  const ranked = (index.tree ?? []).filter(entry => isSafeRepositoryPath(entry.path) && entry.bytes > 0 && entry.bytes <= BYTE_LIMIT && (classifySource(entry.path) || classifyBlueprint(entry.path)))
    .map(entry => ({ entry, score: relevance(entry.path, terms) * 6 + (symbols.get(entry.path) ?? 0) * 8 + (scores.get(entry.path) ?? 0) * 2
      + (/(?:^|\/)(?:main|server|app|index|route|__main__)\./i.test(entry.path) ? 1 : 0) - examplePenalty(entry.path, question) }))
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));
  const selected = new Map<string, RepositoryTreeEntry>();
  // Fetch an explicitly named file even if its overview snippets were already indexed.
  const explicit = ranked.filter(({ entry }) => question.toLowerCase().includes(entry.path.toLowerCase()) || question.toLowerCase().includes(path.posix.basename(entry.path).toLowerCase()));
  for (const { entry } of explicit.filter(({ entry }) => refreshIndexed || !indexed.has(entry.path)).slice(0, 2)) selected.set(entry.path, entry);
  // The overview keeps bounded excerpts. A named function may sit outside them,
  // so re-read its implementation and select windows for this particular question.
  if (refreshIndexed) for (const { entry } of ranked.filter(({ entry }) => indexed.has(entry.path) && (symbols.get(entry.path) ?? 0) > 0).slice(0, 2)) if (selected.size < 3) selected.set(entry.path, entry);
  for (const { entry, score } of ranked) if (score > 0 && !indexed.has(entry.path) && selected.size < 4) selected.set(entry.path, entry);
  for (const { entry, score } of ranked.slice(0, 4)) if (score > 0) {
    for (const imported of localImports(index, entry.path)) {
      const candidate = ranked.find(row => row.entry.path === imported)?.entry;
      if (candidate && !indexed.has(imported) && selected.size < FILE_LIMIT) selected.set(imported, candidate);
    }
  }
  return [...selected.values()].slice(0, FILE_LIMIT);
}

async function readText(response: Response, signal: AbortSignal): Promise<string | null> {
  if (!response.ok || Number(response.headers.get("content-length")) > BYTE_LIMIT || !response.body) { await response.body?.cancel(); return null; }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BYTE_LIMIT) return null;
      chunks.push(value);
    }
    signal.throwIfAborted();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return text.includes("\0") ? null : text;
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); }
}

/** Deterministic research: search the index/tree, then read selected files at the same commit. No LLM call. */
export async function investigateRepository(index: RepositoryIndex, question: string, options: Options = {}): Promise<RepositoryIndex> {
  options.signal?.throwIfAborted();
  let refreshIndexed = !options.freshlyIndexed;
  // Upgrade older owner-scoped lessons automatically, preserving their commit,
  // attachment context, evidence IDs, and diagram references.
  if (!index.tree && /^[a-f0-9]{40}$/.test(index.repository.commit)) {
    try {
      options.onStatus?.("Building the repository file map for this saved walkthrough");
      const fresh = await ingestRepository(index.repository.url + "/tree/" + index.repository.commit, { ownerKey: index.ownerKey, signal: options.signal, fetcher: options.fetcher, allowEmptyEvidence: true });
      const evidence = [...index.evidence];
      for (const source of fresh.evidence) if (!evidence.some(old => old.path === source.path && old.startLine === source.startLine && old.text === source.text)) {
        evidence.push({ ...source, id: "r" + createHash("sha256").update(source.path + ":" + source.startLine + ":" + source.text).digest("hex").slice(0, 24) });
      }
      index = { ...index, tree: fresh.tree, sourceFiles: fresh.sourceFiles, evidence, discoveredFiles: fresh.discoveredFiles, files: [...new Map([...index.files, ...fresh.files].map(file => [file.path, file])).values()], warnings: [...new Set([...index.warnings, ...fresh.warnings])].slice(0, 100) };
      refreshIndexed = false;
    } catch { options.signal?.throwIfAborted(); }
  }
  const candidates = researchCandidates(index, question, refreshIndexed);
  const result = { ...index, evidence: [...index.evidence], files: [...index.files], sourceFiles: [...(index.sourceFiles ?? [])], research: { searchedFiles: index.tree?.length ?? index.files.length, fetchedFiles: 0, paths: [] as string[], notes: [] as string[] } };
  if (!index.tree) { result.research.notes.push("The repository file map was unavailable during this lookup; use the saved evidence without claiming that additional files were searched."); return result; }
  if (!candidates.length) return result;
  if (!/^[a-f0-9]{40}$/.test(index.repository.commit) || ![index.repository.owner, index.repository.name].every(value => /^[\w.-]+$/.test(value) && !/^\.+$/.test(value))) return result;
  const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(options.signal ? [options.signal] : [])]);
  let characters = result.evidence.reduce((sum, source) => sum + source.text.length, 0);
  for (const entry of candidates) {
    options.signal?.throwIfAborted();
    if (signal.aborted || result.evidence.length >= MAX_EVIDENCE || characters >= MAX_EVIDENCE_CHARS) { result.research.notes.push("The bounded source lookup reached its time or evidence limit."); break; }
    options.onStatus?.("Tracing relevant implementation · " + path.posix.basename(entry.path));
    const url = "https://raw.githubusercontent.com/" + [index.repository.owner, index.repository.name, index.repository.commit, ...entry.path.split("/")].map(encodeURIComponent).join("/");
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
      const response = await (options.fetcher ?? fetch)(url, { signal: requestSignal, redirect: "error", credentials: "omit", headers: { Accept: "text/plain" }, cache: "no-store" });
      const text = await readText(response, requestSignal);
      requestSignal.throwIfAborted();
      if (text === null) { result.research.notes.push(path.posix.basename(entry.path) + " was unavailable or exceeded the text limit."); continue; }
      const language = classifySource(entry.path);
      const parsed = language ? analyzeSource(entry.path, text, question) : parseBlueprint(entry.path, text);
      result.research.fetchedFiles++;
      result.research.paths.push(entry.path);
      for (const source of parsed.evidence) {
        if (result.evidence.some(existing => existing.path === source.path && existing.startLine === source.startLine && existing.text === source.text)) continue;
        if (characters + source.text.length > MAX_EVIDENCE_CHARS || result.evidence.length >= MAX_EVIDENCE) break;
        const id = "r" + createHash("sha256").update(entry.path + ":" + source.startLine + ":" + source.text).digest("hex").slice(0, 24);
        result.evidence.push({ ...source, id }); characters += source.text.length;
      }
      if (!result.files.some(file => file.path === entry.path)) result.files.push({ path: entry.path, kind: language ? "source" : classifyBlueprint(entry.path)!, bytes: Buffer.byteLength(text) });
      if ("parser" in parsed) {
        result.sourceFiles = result.sourceFiles.filter(file => file.path !== entry.path);
        result.sourceFiles.push({ path: entry.path, language: parsed.language, parser: parsed.parser, imports: parsed.imports, symbols: parsed.symbols });
      }
    } catch {
      options.signal?.throwIfAborted();
      result.research.notes.push(path.posix.basename(entry.path) + " could not be read during this lookup.");
    }
  }
  options.signal?.throwIfAborted();
  return result;
}
