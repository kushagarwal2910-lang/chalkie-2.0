import type { Evidence, RepositoryIndex } from "./types";

const stop = new Set("the and this that with from what how its for through explain repository supported documented first when then their which does into about only please code project engineer team understand work works working overview purpose starting point would could should want need tell more something".split(" "));
const families = ["auth authentication login logout session", "inference predict prediction generate generation sampler sampling", "cache caching cached", "database db persistence storage", "route routes router endpoint handler", "retry retries backoff", "queue queued worker job jobs", "train training optimizer loss", "deploy deployment container infrastructure"];

export function questionTerms(question: string): string[] {
  const words = question.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  const terms = new Set(words.filter(word => !stop.has(word)));
  for (const family of families) {
    const members = family.split(" ");
    if (members.some(word => terms.has(word))) for (const word of members) terms.add(word);
  }
  return [...terms].slice(0, 60);
}

export function relevance(text: string, terms: readonly string[]) {
  const value = text.toLowerCase();
  return terms.reduce((score, term) => score + (value.includes(term) ? 1 : 0), 0);
}

export function examplePenalty(file: string, question: string): number {
  if (/\b(tests?|testing|specs?|fixtures?|mocks?|examples?|tutorials?|demos?)\b/i.test(question)) return 0;
  return /(?:^|\/)(?:tests?|__tests__|fixtures?|examples?|demos?)(?:\/|$)|(?:^|[._/-])(?:test|spec)(?:[._/-]|$)/i.test(file) ? 20 : 0;
}

/** Rank the whole saved index; the LLM receives only a small, diverse evidence set. */
export function searchRepositoryEvidence(index: RepositoryIndex, question: string, limit = 24): Evidence[] {
  const terms = questionTerms(question);
  const ranked = index.evidence.map(source => ({ source, score: relevance(source.text, terms) * 2 + relevance(source.path, terms) * 5
    + (source.startLine === 1 && /^(README|ARCHITECTURE)\.md$/i.test(source.path) ? 1 : 0) - examplePenalty(source.path, question) })).sort((a, b) => b.score - a.score);
  const selected = new Map<string, Evidence>();
  const add = (source?: Evidence) => { if (source && selected.size < limit) selected.set(source.id, source); };
  // Answer-bearing implementation passages should not lose every slot to file-class diversity.
  for (const row of ranked.filter(row => row.score > 0).slice(0, Math.min(4, limit))) add(row.source);
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
