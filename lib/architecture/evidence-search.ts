import type { Evidence, RepositoryIndex } from "./types";

const stop = new Set("the and this that with from what how its for through explain repository supported documented first when then their which does into about only please code project engineer team understand work works working overview purpose starting point would could should want need tell more something".split(" "));
const families = ["auth authentication login logout session", "inference predict prediction generate generation sampler sampling", "cache caching cached", "database db persistence storage", "route routes router endpoint handler", "retry retries backoff", "queue queued worker job jobs", "train training optimizer loss", "deploy deployment container infrastructure"];

export function questionTerms(question: string): string[] {
  const words = (question + " " + question.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ")).toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  const terms = new Set(words.filter(word => !stop.has(word)));
  for (const family of families) {
    const members = family.split(" ");
    if (members.some(word => terms.has(word))) for (const word of members) terms.add(word);
  }
  return [...terms].slice(0, 60);
}

export type FileAnchor = { path: string; startLine?: number; endLine?: number };
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function isOrientationQuestion(question: string): boolean {
  return /\b(?:onboard(?:ing)?|beginners?|new (?:developer|engineer|contributor)|start(?:ing)? (?:to )?contribut|contribut(?:e|ing|ion)|codebase (?:overview|orientation)|understand (?:this |the )?codebase|where (?:should|do) I start)\b/i.test(question);
}

export function hasExplicitSymbolQuestion(index: RepositoryIndex, question: string): boolean {
  return (index.sourceFiles ?? []).some(file => (file.definitions ?? []).some(({ name }) => {
    if (name.length < 3 || !question.includes(name)) return false;
    const codeLike = /[a-z\d][A-Z]|_|^[A-Z][a-z]/.test(name);
    // A large symbol map contains ordinary words such as repo, help and figure.
    // Only an identifier-shaped or explicitly quoted/called name narrows onboarding.
    return new RegExp("`" + escape(name) + "`|\\b" + escape(name) + "\\s*\\(").test(question)
      || (codeLike && new RegExp("(^|[^a-zA-Z0-9_$])" + escape(name) + "(?![a-zA-Z0-9_$])").test(question));
  }));
}

/** Conventional entrypoints are useful starting places, not proof of runtime behavior. */
export function orientationPathScore(file: string): number {
  if (examplePenalty(file, "") || /(?:^|\/)(?:\.github|\.cargo|\.config|templates?|vendor|scripts?)(?:\/|$)/i.test(file)) return 0;
  const depth = file.split("/").length - 1;
  if (/^(?:readme|contributing|architecture)\.(?:md|rst|txt)$/i.test(file)) return /^contributing/i.test(file) ? 95 : 85;
  if (/(?:^|\/)(?:contribut(?:e|ing|ion)|dev(?:eloper|elopment)?[-_]?(?:guide|howto)?|getting[-_]started|architecture)(?:\.[^/]+|\/(?:index|readme)\.[^/]+)$/i.test(file)) return 75;
  if (/(?:^|\/)(?:index|__init__|mod|lib)\.(?:[cm]?[jt]sx?|py|rs)$/i.test(file)) return 10;
  if (/(?:^|\/)(?:__main__|main|app|server)\.(?:[cm]?[jt]sx?|py|rs|go|java|[ch](?:pp|xx)?)$/i.test(file)) return Math.max(20, 40 - depth * 5);
  return 0;
}

export function hasImplementationEvidence(index: RepositoryIndex, source: Evidence): boolean {
  if (source.kind !== "source") return false;
  // For languages with terse method syntax, the parser's actual definition start
  // must be visible. An import that only mentions a class never qualifies.
  const definitions = index.sourceFiles?.find(file => file.path === source.path)?.definitions;
  if (definitions) return definitions.some(definition => definition.kind !== "variable"
    && definition.startLine >= source.startLine && definition.startLine <= source.endLine && source.text.includes(definition.name));
  return /^\s*(?:(?:export|default|async|pub)\s+)*(?:function|def|class|impl|fn|func)\s+[A-Za-z_$]|=>\s*\{|^\s*return\b/m.test(source.text);
}

/** Resolve user-mentioned filenames against the real file map; never invent a path. */
export function questionFileAnchors(index: RepositoryIndex, question: string): FileAnchor[] {
  const text = question.replaceAll("\\", "/");
  const lower = text.toLowerCase();
  const paths = [...new Set([...(index.tree ?? []).map(file => file.path), ...index.files.map(file => file.path), ...index.evidence.map(source => source.path)])];
  const exact = paths.filter(file => file.includes("/") && lower.includes(file.toLowerCase()));
  const explicitBasenames = new Set(exact.map(file => file.split("/").at(-1)!.toLowerCase()));
  const selected = paths.flatMap(file => {
    const basename = file.split("/").at(-1)!;
    const full = exact.includes(file);
    if (!full && explicitBasenames.has(basename.toLowerCase())) return [];
    const name = full ? file : basename;
    if (!lower.includes(name.toLowerCase())) return [];
    const mention = new RegExp(`(^|[^a-z0-9_.-])${escape(name)}(?![a-z0-9_.-])`, "i").exec(text);
    if (!mention) return [];
    const tail = text.slice(mention.index + mention[0].length);
    const lines = /^\s*(?:#L?|:|(?:[,(]?\s*(?:at\s+)?lines?\s+))(\d+)(?:(?::\d+)?\s*[-–]\s*L?(\d+))?/i.exec(tail);
    const startLine = lines ? Number(lines[1]) : undefined;
    const endLine = lines ? Number(lines[2] ?? lines[1]) : undefined;
    return [{ path: file, ...(startLine && endLine && Number.isSafeInteger(startLine) && Number.isSafeInteger(endLine) && startLine <= endLine ? { startLine, endLine } : {}) }];
  });
  if (selected.length === 1 && !selected[0].startLine) {
    const lines = /\blines?\s+(\d+)(?:\s*[-–]\s*(\d+))?/i.exec(text);
    if (lines && Number.isSafeInteger(Number(lines[1])) && Number.isSafeInteger(Number(lines[2] ?? lines[1])) && Number(lines[1]) > 0 && Number(lines[2] ?? lines[1]) >= Number(lines[1])) Object.assign(selected[0], { startLine: Number(lines[1]), endLine: Number(lines[2] ?? lines[1]) });
  }
  return selected;
}

export function relevance(text: string, terms: readonly string[]) {
  const value = text.toLowerCase();
  return terms.reduce((score, term) => score + (value.includes(term) ? 1 : 0), 0);
}

export function examplePenalty(file: string, question: string): number {
  if (/\b(tests?|testing|specs?|fixtures?|mocks?|examples?|tutorials?|demos?|bench(?:marks?|es)?)\b/i.test(question)) return 0;
  return /(?:^|\/)(?:tests?|__tests__|fixtures?|examples?|demos?|bench(?:marks?|es)?)(?:\/|$)|(?:^|[._/-])(?:test|spec)(?:[._/-]|$)/i.test(file) ? 20 : 0;
}

/** Rank the whole saved index; the LLM receives only a small, diverse evidence set. */
export function searchRepositoryEvidence(index: RepositoryIndex, question: string, limit = 24): Evidence[] {
  const terms = questionTerms(question);
  const anchors = new Map(questionFileAnchors(index, question).map(anchor => [anchor.path, anchor]));
  const orientation = !anchors.size && isOrientationQuestion(question) && !hasExplicitSymbolQuestion(index, question);
  const ranked = index.evidence.map(source => ({ source, score: relevance(source.text, terms) * 2 + relevance(source.path, terms) * 5
    + (orientation ? orientationPathScore(source.path) + (hasImplementationEvidence(index, source) ? 70 : 0) + (source.kind === "source" && index.research?.paths.includes(source.path) ? 15 : 0) : 0)
    + (source.startLine === 1 && /^(README|ARCHITECTURE)\.md$/i.test(source.path) ? 1 : 0) - examplePenalty(source.path, question)
    + (anchors.has(source.path) ? 1000 : 0) + (anchors.get(source.path)?.startLine && source.startLine <= anchors.get(source.path)!.endLine! && source.endLine >= anchors.get(source.path)!.startLine! ? 10000 : 0) })).sort((a, b) => b.score - a.score);
  const selected = new Map<string, Evidence>();
  const add = (source?: Evidence) => { if (source && selected.size < limit) selected.set(source.id, source); };
  // Answer-bearing implementation passages should not lose every slot to file-class diversity.
  if (orientation) {
    const pathCounts = new Map<string, number>();
    // A contributor needs an actual implementation beside the orientation guide.
    for (const kind of ["documentation", "source", "documentation", "source"]) {
      const row = ranked.find(row => row.source.kind === kind && !selected.has(row.source.id) && (pathCounts.get(row.source.path) ?? 0) < 2);
      if (row) { add(row.source); pathCounts.set(row.source.path, (pathCounts.get(row.source.path) ?? 0) + 1); }
    }
  } else for (const row of ranked.filter(row => row.score > 0).slice(0, Math.min(4, limit))) add(row.source);
  for (const kind of ["documentation", "source", "compose", "terraform", "kubernetes", "cloudformation", "dependencies", "docker"]) {
    add(ranked.find(row => row.source.kind === kind && row.source.origin !== "attachment")?.source);
  }
  const paths = new Set<string>();
  for (const { source } of ranked) if (source.origin === "attachment" && !paths.has(source.path)) { add(source); paths.add(source.path); }
  // Keep nearby implementation context: the caller and imported module can be different files.
  const sourcePaths = new Set<string>();
  for (const { source } of ranked) if (source.kind === "source" && !sourcePaths.has(source.path)) { add(source); sourcePaths.add(source.path); if (sourcePaths.size >= 4) break; }
  for (const { source } of ranked) add(source);
  let bytes = 0;
  return [...selected.values()].filter(source => { if (bytes + source.text.length > 38000) return false; bytes += source.text.length; return true; });
}
