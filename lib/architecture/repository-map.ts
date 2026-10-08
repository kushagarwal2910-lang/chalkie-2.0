import { questionTerms, relevance, examplePenalty } from "./evidence-search";
import type { Evidence, RepositoryIndex } from "./types";

export function repositoryCoverage(index: RepositoryIndex) {
  return { mappedFiles: index.tree?.length ?? index.files.length, analyzedFiles: index.sourceFiles?.length ?? 0,
    definitionCount: (index.sourceFiles ?? []).reduce((count, file) => count + (file.definitions?.length ?? 0), 0),
    partialAnalyses: (index.sourceFiles ?? []).filter(file => !file.analysisComplete).length };
}

/** A navigable local catalog, independent of the excerpts sent to the model. */
export function listRepositoryMap(index: RepositoryIndex, query = "", offset = 0, limit = 60) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const metadata = new Map(index.sourceFiles?.map(file => [file.path, file]));
  const indexed = new Set(index.files.map(file => file.path));
  const rows = (index.tree ?? index.files.map(file => ({ ...file, kind: file.kind === "source" ? "source" : "blueprint" }))).map(file => {
    const source = metadata.get(file.path);
    return { ...file, indexed: indexed.has(file.path), parser: source?.parser, analysisComplete: source?.analysisComplete,
      definitions: source?.definitions ?? [], imports: source?.imports ?? [],
      score: relevance(file.path, terms) * 4 + relevance(source?.definitions?.map(symbol => symbol.name).join(" ") ?? "", terms) * 3 };
  }).filter(file => !terms.length || terms.every(term => (file.path + " " + file.definitions.map(symbol => symbol.name).join(" ")).toLowerCase().includes(term))).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const start = Math.max(0, Math.floor(offset));
  const page = rows.slice(start, start + Math.min(100, Math.max(1, limit))).map(({ score, ...file }) => { void score; return file; });
  return { repository: index.repository, ...repositoryCoverage(index), total: rows.length, offset: start, files: page,
    nextOffset: start + page.length < rows.length ? start + page.length : null,
    exclusions: "Generated, vendored, credential and binary contents are not analyzed. Syntax metadata describes static code, not verified runtime calls." };
}

/** Compact navigation context. The complete filtered tree stays searchable locally. */
export function modelRepositoryMap(index: RepositoryIndex, question: string, evidence: Evidence[]) {
  const terms = questionTerms(question);
  const selected = new Set(evidence.filter(item => item.origin !== "attachment").map(item => item.path));
  const directories = new Map<string, number>();
  for (const file of index.tree ?? []) {
    const parts = file.path.split("/");
    const directory = parts.length === 1 ? "/" : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
    directories.set(directory, (directories.get(directory) ?? 0) + 1);
  }
  const ranked = (index.sourceFiles ?? []).map(file => ({ file,
    score: (selected.has(file.path) ? 20 : 0) + relevance(file.path + " " + (file.definitions ?? []).map(symbol => symbol.name).join(" "), terms) * 3 - examplePenalty(file.path, question) }))
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  const definitionScore = (symbol: { name: string; kind: string }) => relevance(symbol.name, terms) * 10 + (symbol.kind === "class" || symbol.kind === "interface" ? 5 : symbol.kind === "variable" ? 0 : 3);
  const files = ranked.slice(0, 10).map(({ file }) => ({ path: file.path, parser: file.parser,
    definitions: [...(file.definitions ?? [])].sort((a, b) => definitionScore(b) - definitionScore(a)).slice(0, 6)
      .map(symbol => `${symbol.kind} ${symbol.name}:${symbol.startLine}-${symbol.endLine}`),
    imports: file.imports.slice(0, 4), complete: file.analysisComplete ?? false }));
  const branches = [...directories].sort((a, b) => relevance(b[0], terms) - relevance(a[0], terms) || b[1] - a[1]).slice(0, 20).map(([path, files]) => ({ path, files }));
  const map = { ...repositoryCoverage(index), listing: "Relevant subset of the locally searchable file/symbol map; only evidence passages support behavior claims.", directories: branches, files };
  while (JSON.stringify(map).length > 2400) {
    if (map.files.length > 2) map.files.pop();
    else if (map.directories.length > 4) map.directories.pop();
    else if (map.files.length > 0) map.files.pop();
    else break;
  }
  return map;
}
