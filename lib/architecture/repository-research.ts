import { createHash } from "node:crypto";
import path from "node:path";
import { classifyBlueprint, parseBlueprint, redactSecrets } from "./blueprints";
import { analyzeSource, classifySource, isSafeRepositoryPath } from "./source-analysis";
import { questionTerms, questionFileAnchors, relevance, examplePenalty, isOrientationQuestion, orientationPathScore, hasExplicitSymbolQuestion, hasImplementationEvidence } from "./evidence-search";
import type { Evidence, RepositoryIndex, RepositoryTreeEntry } from "./types";
import { ingestRepository } from "./github";

const FILE_LIMIT = 12;
const BYTE_LIMIT = 512000;
const MAX_EVIDENCE = 6000;
const MAX_EVIDENCE_CHARS = 7_000_000;
export type RepositoryResearchOptions = { signal?: AbortSignal; fetcher?: typeof fetch; onStatus?: (message: string) => void; freshlyIndexed?: boolean; maxFiles?: number; maxBytes?: number; maxHops?: number };
const bounded = (value: number | undefined, fallback: number) => value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;

/** Safe text can answer a concrete question even when it is not an IaC blueprint. */
export function isResearchReadablePath(file: string): boolean {
  if (!isSafeRepositoryPath(file) || /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|composer\.lock|poetry\.lock|uv\.lock|Cargo\.lock|Gemfile\.lock)$|\.lock$/i.test(file)) return false;
  return Boolean(classifySource(file) || classifyBlueprint(file) || /\.(?:md|mdx|rst|txt|json|toml|ini|cfg|xml|ya?ml)$/i.test(file));
}

function documentExcerpts(file: string, text: string, question: string, ranges: Array<{ startLine: number; endLine?: number }>) {
  // Redact before slicing and preserve line positions, including multi-line PEMs.
  const masked = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, block => "[REDACTED PRIVATE KEY]" + "\n".repeat((block.match(/\n/g) ?? []).length));
  const lines = redactSecrets(masked).split(/\r?\n/);
  const starts = new Set<number>();
  for (const range of ranges) for (let line = Math.max(0, range.startLine - 1); line < Math.min(lines.length, range.endLine ?? range.startLine) && starts.size < 16; line += 12) starts.add(line);
  const terms = questionTerms(question);
  const matches = lines.map((line, position) => ({ position, score: relevance(line, terms) })).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.position - b.position);
  for (const match of matches.slice(0, 8)) starts.add(Math.max(0, match.position - 2));
  if (starts.size < 16) starts.add(0);
  const evidence: Omit<Evidence, "id">[] = [];
  for (const start of [...starts].slice(0, 16)) {
    let excerpt = "", end = start;
    while (end < lines.length && end < start + 20 && excerpt.length < 1800) {
      const remaining = 1800 - excerpt.length - (excerpt ? 1 : 0);
      if (excerpt && lines[end].length > remaining) break;
      excerpt += (excerpt ? "\n" : "") + lines[end].slice(0, remaining); end++;
    }
    if (excerpt.trim() && !evidence.some(source => source.startLine === start + 1 && source.text === excerpt)) evidence.push({ path: file, startLine: start + 1, endLine: Math.max(start + 1, end), text: excerpt, kind: "documentation" });
  }
  return { kind: "documentation" as const, evidence, warnings: [] as string[] };
}

type ImportGraph = { imports: Map<string, string[]>; importers: Map<string, string[]> };
const stem = (file: string) => file.replace(/\.(?:[cm]?[jt]sx?|py|java|go|rs|[ch](?:pp|xx|c)?|hpp|hh|hxx|kt|kts|cs|rb|php|swift)$/, "").replace(/\/(?:index|__init__|mod)$/, "");
type ImportLookup = { exact: Map<string, Set<string>>; suffix: Map<string, Set<string>>; goPackages: Map<string, Set<string>> };
const importLookups = new WeakMap<RepositoryTreeEntry[], ImportLookup>();

/** A static import graph, not proof of runtime calls or dynamically loaded modules. */
function importGraph(index: RepositoryIndex): ImportGraph {
  const entries = index.tree ?? [];
  let lookup = importLookups.get(entries);
  if (!lookup) {
    const exact = new Map<string, Set<string>>(), suffix = new Map<string, Set<string>>(), goPackages = new Map<string, Set<string>>();
    const add = (map: Map<string, Set<string>>, key: string, file: string) => { const values = map.get(key) ?? new Set<string>(); values.add(file); map.set(key, values); };
    for (const entry of entries) {
      if (!isSafeRepositoryPath(entry.path)) continue;
      add(exact, entry.path, entry.path); add(exact, stem(entry.path), entry.path);
      const parts = stem(entry.path).split("/");
      for (let i = 0; i < parts.length; i++) add(suffix, parts.slice(i).join("/"), entry.path);
      if (entry.path.endsWith(".go")) add(goPackages, path.posix.dirname(entry.path), entry.path);
    }
    lookup = { exact, suffix, goPackages }; importLookups.set(entries, lookup);
  }
  const { exact, suffix, goPackages } = lookup;
  const graph: ImportGraph = { imports: new Map(), importers: new Map() };
  for (const file of index.sourceFiles ?? []) {
    const dependencies = new Set<string>();
    for (const imported of file.imports) {
      if (/https?:|^[a-z]:|\\|[\x00-\x1f]/i.test(imported)) continue;
      let relative: string | undefined;
      if (imported.startsWith(".")) {
        if (file.path.endsWith(".py")) {
          const dots = imported.match(/^\.+/)![0].length;
          relative = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), ...Array.from({ length: dots - 1 }, () => ".."), imported.slice(dots).replaceAll(".", "/")));
        } else relative = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), imported));
      }
      let modulePath = imported.startsWith("@/") ? imported.slice(2) : /\.(?:py|java)$/.test(file.path) ? imported.replaceAll(".", "/") : imported;
      if (/\.[ch](?:pp|xx|c)?$|\.h(?:pp|h|xx)$/.test(file.path) && !relative) relative = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), imported));
      if (file.path.endsWith(".go")) modulePath = modulePath.replace(new RegExp("^github\\.com/" + index.repository.owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/" + index.repository.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/"), "");
      if (file.path.endsWith(".rs")) {
        const modules = imported.split("::").filter(Boolean);
        const sourceRoot = file.path.includes("/src/") ? file.path.slice(0, file.path.lastIndexOf("/src/") + 4) : "src";
        let base = /(?:^|\/)(?:lib|main)\.rs$/.test(file.path) ? path.posix.dirname(file.path) : stem(file.path);
        if (modules[0] === "crate") { base = sourceRoot; modules.shift(); }
        else if (modules[0] === "self") modules.shift();
        else while (modules[0] === "super") { base = path.posix.dirname(base); modules.shift(); }
        modulePath = path.posix.join(base, ...modules);
        while (!exact.has(modulePath) && modules.length > 1) { modules.pop(); modulePath = path.posix.join(base, ...modules); }
      }
      let matches = relative ? exact.get(relative) ?? exact.get(stem(relative)) : exact.get(modulePath) ?? ((imported.startsWith("@/") || /\.(?:py|java)$/.test(file.path)) ? suffix.get(modulePath) : undefined);
      if (!matches && file.path.endsWith(".go")) matches = goPackages.get(modulePath);
      if (!matches && /\.[ch](?:pp|xx|c)?$|\.h(?:pp|h|xx)$/.test(file.path)) matches = exact.get(imported) ?? exact.get("include/" + imported);
      if (!matches && file.path.endsWith(".java")) { const parts = modulePath.split("/"); parts.pop(); matches = exact.get(parts.join("/")) ?? suffix.get(parts.join("/")); }
      for (const dependency of matches ?? []) if (dependency !== file.path) dependencies.add(dependency);
    }
    graph.imports.set(file.path, [...dependencies]);
    for (const dependency of dependencies) graph.importers.set(dependency, [...(graph.importers.get(dependency) ?? []), file.path]);
  }
  return graph;
}

function researchPlan(index: RepositoryIndex, question: string, refreshIndexed: boolean, maxFiles: number, maxHops: number, originalSeeds?: string[]) {
  const terms = questionTerms(question);
  const anchors = new Map(questionFileAnchors(index, question).map(anchor => [anchor.path, anchor]));
  const scores = new Map<string, number>();
  for (const source of index.evidence) if (source.origin !== "attachment") scores.set(source.path, Math.max(scores.get(source.path) ?? 0, relevance(source.text, terms)));
  // The file/definition map is much larger than the stored overview excerpts.
  const indexed = new Set(index.evidence.filter(source => source.origin !== "attachment").map(source => source.path));
  const symbols = new Map(index.sourceFiles?.map(file => [file.path, relevance([...file.symbols, ...(file.definitions ?? []).map(definition => definition.name)].join(" "), terms)]));
  const orientation = !anchors.size && isOrientationQuestion(question) && !hasExplicitSymbolQuestion(index, question);
  const graph = importGraph(index);
  const implementationFiles = new Set((index.sourceFiles ?? []).filter(file => file.definitions?.some(definition => ["function", "method", "class"].includes(definition.kind))).map(file => file.path));
  for (const source of index.evidence) if (hasImplementationEvidence(index, source)) implementationFiles.add(source.path);
  const ranked = (index.tree ?? []).filter(entry => isResearchReadablePath(entry.path) && entry.bytes > 0 && entry.bytes <= BYTE_LIMIT)
    .map(entry => ({ entry, score: relevance(entry.path, terms) * 6 + (symbols.get(entry.path) ?? 0) * 8 + (scores.get(entry.path) ?? 0) * 2
      + (orientation ? orientationPathScore(entry.path) + (implementationFiles.has(entry.path) ? 70 : 0) + Math.min(50, (graph.importers.get(entry.path)?.length ?? 0) * 8) : 0)
      + (/(?:^|\/)(?:main|server|app|index|route|__main__)\./i.test(entry.path) ? 1 : 0) - examplePenalty(entry.path, question) }))
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));
  const selected = new Map<string, RepositoryTreeEntry>();
  const byPath = new Map(ranked.map(row => [row.entry.path, row.entry]));
  const admit = (file: string, allowRefresh = refreshIndexed) => {
    const entry = byPath.get(file);
    if (entry && (allowRefresh || !indexed.has(file)) && selected.size < maxFiles) selected.set(file, entry);
  };
  const explicit = ranked.filter(row => anchors.has(row.entry.path));
  for (const { entry } of explicit) admit(entry.path, refreshIndexed || Boolean(anchors.get(entry.path)?.startLine));
  // Named functions may be present in the definition map but outside the saved
  // overview excerpts. Re-read those files with the current question/range.
  const symbolMatches = ranked.filter(row => (symbols.get(row.entry.path) ?? 0) > 0);
  if (!explicit.length && !orientation) for (const { entry } of symbolMatches.slice(0, Math.max(2, Math.ceil(maxFiles / 3)))) admit(entry.path);
  const relevant = ranked.filter(row => row.score > 0);
  const orientationRows: typeof ranked = [];
  if (orientation) {
    orientationRows.push(...ranked.filter(row => !classifySource(row.entry.path) && orientationPathScore(row.entry.path) >= 70).slice(0, 2));
    const sourceRows = ranked.filter(row => classifySource(row.entry.path) && !examplePenalty(row.entry.path, question) && !/(?:^|\/)(?:\.github|templates?)(?:\/|$)/i.test(row.entry.path));
    const directories = new Set<string>();
    let sourceCount = 0;
    const body = sourceRows.find(row => implementationFiles.has(row.entry.path));
    if (body) { orientationRows.push(body); directories.add(path.posix.dirname(body.entry.path)); sourceCount++; }
    const entrypoint = sourceRows.find(row => orientationPathScore(row.entry.path) > 0);
    if (entrypoint && entrypoint !== body) { orientationRows.push(entrypoint); directories.add(path.posix.dirname(entrypoint.entry.path)); sourceCount++; }
    for (const row of sourceRows) if (!directories.has(path.posix.dirname(row.entry.path))) {
      orientationRows.push(row); directories.add(path.posix.dirname(row.entry.path)); sourceCount++;
      if (sourceCount >= 4) break;
    }
  }
  const seedRows = explicit.length ? explicit : orientationRows.length ? orientationRows : symbolMatches.length ? symbolMatches.slice(0, 4) : relevant.slice(0, 4);
  const seeds = originalSeeds ?? (seedRows.length ? seedRows : ranked.filter(row => !indexed.has(row.entry.path)).slice(0, 4)).map(row => row.entry.path);
  for (const file of seeds) admit(file, refreshIndexed || (orientation && implementationFiles.has(file) && !index.evidence.some(source => source.path === file && hasImplementationEvidence(index, source))));
  let frontier = seeds;
  const visited = new Set(seeds);
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next: string[] = [];
    const dependencies = frontier.flatMap(file => graph.imports.get(file) ?? []);
    const importers = frontier.flatMap(file => graph.importers.get(file) ?? []);
    const rank = new Map(ranked.map(row => [row.entry.path, row.score]));
    const ordered = orientation ? [dependencies, importers].flatMap(group => [...new Set(group)].filter(file => !examplePenalty(file, question)).sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0))) : [...dependencies, ...importers];
    for (const neighbor of ordered) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor); next.push(neighbor); admit(neighbor);
    }
    frontier = next;
  }
  if (!explicit.length) for (const { entry } of relevant) if (!indexed.has(entry.path) && (!orientation || !examplePenalty(entry.path, question))) admit(entry.path);
  return { candidates: [...selected.values()], seeds };
}

export function researchCandidates(index: RepositoryIndex, question: string, refreshIndexed = true, options: Pick<RepositoryResearchOptions, "maxFiles" | "maxHops"> = {}): RepositoryTreeEntry[] {
  return researchPlan(index, question, refreshIndexed, bounded(options.maxFiles, FILE_LIMIT), bounded(options.maxHops, 2)).candidates;
}

async function readText(response: Response, signal: AbortSignal, limit: number, onBytes: (bytes: number) => void): Promise<{ text: string | null; bytes: number }> {
  if (!response.ok || Number(response.headers.get("content-length")) > limit || !response.body) { await response.body?.cancel(); return { text: null, bytes: 0 }; }
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
      onBytes(value.byteLength);
      if (size > limit) return { text: null, bytes: size };
      chunks.push(value);
    }
    signal.throwIfAborted();
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { return { text: null, bytes: size }; }
    return { text: text.includes("\0") ? null : text, bytes: size };
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); }
}

/** Deterministic research: search the index/tree, then read selected files at the same commit. No LLM call. */
export async function investigateRepository(index: RepositoryIndex, question: string, options: RepositoryResearchOptions = {}): Promise<RepositoryIndex> {
  options.signal?.throwIfAborted();
  const signal = AbortSignal.any([AbortSignal.timeout(40000), ...(options.signal ? [options.signal] : [])]);
  let refreshIndexed = !options.freshlyIndexed;
  // Upgrade older owner-scoped lessons automatically, preserving their commit,
  // attachment context, evidence IDs, and diagram references.
  if ((!index.tree || index.analysisVersion !== 2) && /^[a-f0-9]{40}$/.test(index.repository.commit)) {
    try {
      options.onStatus?.("Building the repository file map for this saved walkthrough");
      const fresh = await ingestRepository(index.repository.url + "/tree/" + index.repository.commit, { ownerKey: index.ownerKey, signal, fetcher: options.fetcher, allowEmptyEvidence: true });
      const evidence = [...index.evidence];
      for (const source of fresh.evidence) if (!evidence.some(old => old.path === source.path && old.startLine === source.startLine && old.text === source.text)) {
        evidence.push({ ...source, id: "r" + createHash("sha256").update(source.path + ":" + source.startLine + ":" + source.text).digest("hex").slice(0, 24) });
      }
      index = { ...index, analysisVersion: fresh.analysisVersion, tree: fresh.tree, sourceFiles: fresh.sourceFiles, evidence, discoveredFiles: fresh.discoveredFiles, files: [...new Map([...index.files, ...fresh.files].map(file => [file.path, file])).values()], warnings: [...new Set([...index.warnings, ...fresh.warnings])].slice(0, 100) };
      refreshIndexed = false;
    } catch { options.signal?.throwIfAborted(); }
  }
  const maxFiles = bounded(options.maxFiles, FILE_LIMIT), maxBytes = bounded(options.maxBytes, FILE_LIMIT * BYTE_LIMIT), maxHops = bounded(options.maxHops, 2);
  const initial = researchPlan(index, question, refreshIndexed, maxFiles, maxHops);
  const result = { ...index, evidence: [...index.evidence], files: [...index.files], sourceFiles: [...(index.sourceFiles ?? [])], research: { searchedFiles: index.tree?.length ?? index.files.length, fetchedFiles: 0, paths: [] as string[], notes: [] as string[] } };
  if (!index.tree) { result.research.notes.push("The repository file map was unavailable during this lookup; use the saved evidence without claiming that additional files were searched."); return result; }
  if (!initial.candidates.length || !maxBytes) return result;
  if (!/^[a-f0-9]{40}$/.test(index.repository.commit) || ![index.repository.owner, index.repository.name].every(value => /^[\w.-]+$/.test(value) && !/^\.+$/.test(value))) return result;
  let characters = result.evidence.reduce((sum, source) => sum + source.text.length, 0);
  let bytes = 0;
  const attempted = new Set<string>();
  const anchors = new Map(questionFileAnchors(index, question).map(anchor => [anchor.path, anchor]));
  while (attempted.size < maxFiles) {
    // Newly read imports can expose another hop. Re-plan against the updated
    // static graph while keeping the original seeds, so the hop bound is real.
    const entry = researchPlan(result, question, refreshIndexed, maxFiles, maxHops, initial.seeds).candidates.find(candidate => !attempted.has(candidate.path));
    if (!entry) break;
    options.signal?.throwIfAborted();
    if (signal.aborted || bytes >= maxBytes || result.evidence.length >= MAX_EVIDENCE || characters >= MAX_EVIDENCE_CHARS) { result.research.notes.push("The source lookup reached its time, byte, or evidence budget; additional files may remain relevant."); break; }
    attempted.add(entry.path);
    if (entry.bytes > maxBytes - bytes) { result.research.notes.push(path.posix.basename(entry.path) + " exceeded the remaining source lookup byte budget."); continue; }
    options.onStatus?.("Tracing relevant implementation · " + path.posix.basename(entry.path));
    const url = "https://raw.githubusercontent.com/" + [index.repository.owner, index.repository.name, index.repository.commit, ...entry.path.split("/")].map(encodeURIComponent).join("/");
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
      const response = await (options.fetcher ?? fetch)(url, { signal: requestSignal, redirect: "error", credentials: "omit", headers: { Accept: "text/plain" }, cache: "no-store" });
      const { text } = await readText(response, requestSignal, Math.min(BYTE_LIMIT, maxBytes - bytes), count => { bytes += count; });
      requestSignal.throwIfAborted();
      if (text === null) { result.research.notes.push(path.posix.basename(entry.path) + " was unavailable or exceeded the text limit."); continue; }
      const language = classifySource(entry.path);
      const anchor = anchors.get(entry.path);
      const focusRanges = anchor?.startLine ? [{ startLine: anchor.startLine, endLine: anchor.endLine }] : [];
      if (anchor?.startLine && anchor.startLine > text.split(/\r?\n/).length) result.research.notes.push(path.posix.basename(entry.path) + " does not contain the requested line range.");
      const blueprint = !language && classifyBlueprint(entry.path) ? parseBlueprint(entry.path, text) : null;
      const parsed = language ? analyzeSource(entry.path, text, question, focusRanges) : blueprint?.evidence.length
        ? { ...blueprint, evidence: [...(focusRanges.length ? documentExcerpts(entry.path, text, question, focusRanges).evidence : []), ...blueprint.evidence] }
        : documentExcerpts(entry.path, text, question, focusRanges);
      result.research.fetchedFiles++;
      result.research.paths.push(entry.path);
      for (const source of parsed.evidence) {
        if (result.evidence.some(existing => existing.path === source.path && existing.startLine === source.startLine && existing.text === source.text)) continue;
        if (characters + source.text.length > MAX_EVIDENCE_CHARS || result.evidence.length >= MAX_EVIDENCE) break;
        const id = "r" + createHash("sha256").update(entry.path + ":" + source.startLine + ":" + source.text).digest("hex").slice(0, 24);
        result.evidence.push({ ...source, id }); characters += source.text.length;
      }
      if (!result.files.some(file => file.path === entry.path)) result.files.push({ path: entry.path, kind: "parser" in parsed ? "source" : parsed.kind, bytes: Buffer.byteLength(text) });
      if ("parser" in parsed) {
        result.sourceFiles = result.sourceFiles.filter(file => file.path !== entry.path);
        result.sourceFiles.push({ path: entry.path, language: parsed.language, parser: parsed.parser, imports: parsed.imports, symbols: parsed.symbols, definitions: parsed.definitions, analysisComplete: parsed.analysisComplete });
      }
    } catch {
      options.signal?.throwIfAborted();
      result.research.notes.push(path.posix.basename(entry.path) + " could not be read during this lookup.");
    }
  }
  if (attempted.size === maxFiles && researchPlan(result, question, refreshIndexed, maxFiles + 1, maxHops, initial.seeds).candidates.some(entry => !attempted.has(entry.path))) result.research.notes.push("The source lookup reached its " + maxFiles + "-file budget. The inspected imports are a partial dependency map, not a complete blast-radius analysis.");
  options.signal?.throwIfAborted();
  return result;
}
