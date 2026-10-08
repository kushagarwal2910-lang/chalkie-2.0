import { getAsset, isKnownAsset } from "./assets";
import type { Evidence } from "./types";

type Certainty = "declared" | "documented" | "inferred" | "unknown";
type NodeIdentity = { label: string; assetId?: string };
type GroundableNode = NodeIdentity & { assetId: string; kind: string; certainty: Certainty; evidenceIds: readonly string[] };

const normalizeSpace = (text: string) => text.replace(/\s+/g, " ").trim();
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A name is not established merely because it is a substring of another word. */
function mentions(text: string, name: string): boolean {
  const value = normalizeSpace(name);
  if (!value) return false;
  return new RegExp("(?<![\\p{L}\\p{N}_])" + escapePattern(value) + "(?![\\p{L}\\p{N}_])", "iu").test(normalizeSpace(text));
}

function technologyNames(assetId?: string): string[] {
  if (!assetId?.startsWith("tech:") || !isKnownAsset(assetId)) return [];
  const asset = getAsset(assetId);
  return [...new Set([asset.name, ...asset.aliases].map(normalizeSpace).filter(Boolean))];
}

function technologyMentioned(text: string, assetId?: string): boolean {
  return technologyNames(assetId).some(name => {
    // A list marker "C"/"R", or ordinary prose "go", is not a language declaration.
    if (/^(c|r|go)$/i.test(name)) {
      return new RegExp("(?:`" + name + "`|\\b" + name + "\\s+(?:language|runtime|compiler|programming|module)\\b|\\b(?:written|implemented|coded|programmed)\\s+in\\s+" + name + "\\b|[\"']" + name + "[\"']\\s*:|\\b" + name + "\\s+[0-9]+\\.[0-9]+)", "i").test(text);
    }
    return mentions(text, name);
  });
}

/**
 * A literal quote must occur inside one of the cited excerpts. This checks
 * provenance, not whether the quote logically entails the generated claim.
 */
export function quoteMatchesEvidence(quote: string, evidenceIds: readonly string[], evidence: readonly Evidence[]): boolean {
  const exact = normalizeSpace(quote);
  if (!exact) return false;
  const refs = new Set(evidenceIds);
  return evidence.some(source => refs.has(source.id) && normalizeSpace(source.text).includes(exact));
}

/** Conservative identity check; callers still need to validate the claimed relationship. */
export function nodeIdentityMentioned(node: NodeIdentity, text: string): boolean {
  const label = normalizeSpace(node.label);
  if (mentions(text, label)) return true;
  const spokenIdentifier = (value: string) => value.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").replace(/[_$]+/g, " ").trim().toLowerCase();
  if ((text.match(/\b[a-zA-Z_$][\w$]*\b/g) ?? []).some(identifier => /_|[a-z][A-Z]/.test(identifier) && spokenIdentifier(identifier) === spokenIdentifier(label))) return true;
  // Human-friendly labels may add a role, but never reduce to a generic noun.
  const withoutRole = label.replace(/\s+(?:service|server|database|cache|queue|worker|container|framework|library|client|gateway|model|pipeline|component)$/i, "");
  if (withoutRole !== label && withoutRole.length >= 2 && !/^(?:the|a|an|main|primary|backend|frontend|data|web|application|background)$/i.test(withoutRole) && mentions(text, withoutRole)) return true;
  // A Redis logo must not make an otherwise unnamed "Billing API" look grounded.
  const aliases = technologyNames(node.assetId);
  return aliases.some(name => mentions(label, name)) && technologyMentioned(text, node.assetId);
}

export function edgeEndpointsMentioned(from: NodeIdentity, to: NodeIdentity, text: string): boolean {
  return nodeIdentityMentioned(from, text) && nodeIdentityMentioned(to, text);
}

/** Correct presentation claims locally, without another model request or mutating its input. */
export function enforceNodeGrounding<T extends GroundableNode>(node: T, evidence: readonly Evidence[]): T {
  const corrected = { ...node };
  const refs = new Set(node.evidenceIds);
  const cited = evidence.filter(source => refs.has(source.id));
  const dependenciesOnly = cited.length > 0 && cited.every(source => source.kind === "dependencies");
  // A dependency is an installed package, not evidence of a deployed service.
  if (dependenciesOnly) corrected.kind = "unknown";
  if (!cited.length) corrected.certainty = "unknown";
  else if (corrected.certainty === "declared" && cited.every(source => source.origin === "attachment" || source.kind === "documentation" || source.kind === "dependencies" || source.kind === "source")) corrected.certainty = "documented";

  if (!isKnownAsset(corrected.assetId) || corrected.assetId.startsWith("tech:") && !cited.some(source => technologyMentioned(source.text, corrected.assetId))) {
    const fallback = "concept:" + corrected.kind;
    corrected.assetId = isKnownAsset(fallback) ? fallback : "concept:unknown";
  } else if (dependenciesOnly && corrected.assetId.startsWith("concept:")) corrected.assetId = "concept:unknown";
  return corrected;
}
