import type { LessonPlan } from "../lesson-schema";
import type { Explanation } from "./explanation";
import { edgeEndpointsMentioned, enforceNodeGrounding, nodeIdentityMentioned, quoteMatchesEvidence } from "./grounding";
import type { Evidence } from "./types";

type Proof = { id: string; supportingQuote: string };
export type GeneratedGroundingProofs = { nodes: readonly Proof[]; edges: readonly Proof[] };

function proofMap(proofs: readonly Proof[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const proof of proofs) {
    if (result.has(proof.id)) throw new Error("Duplicate grounding proof: " + proof.id);
    result.set(proof.id, proof.supportingQuote);
  }
  return result;
}

function supportingSources(id: string, refs: readonly string[], proofs: Map<string, string>, evidence: readonly Evidence[]): { quote: string; sources: Evidence[] } {
  const quote = proofs.get(id);
  if (!quote?.trim()) throw new Error("Missing supporting quote: " + id);
  const sources = evidence.filter(source => refs.includes(source.id) && quoteMatchesEvidence(quote, [source.id], [source]));
  if (!sources.length) throw new Error("Supporting quote does not match cited evidence: " + id);
  return { quote, sources };
}

function declaresStartupDependency(source: Evidence, from: { label: string; assetId?: string }, to: { label: string; assetId?: string }): boolean {
  const match = source.text.match(/^service ([^:]+): (\{[\s\S]*\})$/);
  if (!match || !nodeIdentityMentioned(from, match[1])) return false;
  try {
    const config = JSON.parse(match[2]) as { depends_on?: unknown };
    const dependencies = Array.isArray(config.depends_on) ? config.depends_on.filter((value): value is string => typeof value === "string")
      : config.depends_on && typeof config.depends_on === "object" ? Object.keys(config.depends_on) : [];
    return dependencies.some(name => nodeIdentityMentioned(to, name));
  } catch { return false; }
}

/**
 * Validate model-only proof fields before discarding them. Quotes and endpoint
 * mentions establish provenance; prose claims still require model grounding.
 * Structured Compose relationships can additionally be checked deterministically.
 */
export function validateGeneratedGrounding(plan: Explanation, proofs: GeneratedGroundingProofs, evidence: readonly Evidence[], current?: LessonPlan): Explanation {
  const nodeProofs = proofMap(proofs.nodes);
  const edgeProofs = proofMap(proofs.edges);
  const nodes = plan.nodes.map(node => {
    const { quote, sources } = supportingSources(node.id, node.evidenceIds, nodeProofs, evidence);
    if (!nodeIdentityMentioned(node, quote)) throw new Error("Node identity is missing from its supporting quote: " + node.id);
    // An unrelated infrastructure citation must not upgrade a documentation claim.
    return enforceNodeGrounding({ ...node, evidenceIds: sources.map(source => source.id) }, sources);
  });
  const byId = new Map<string, { label: string; assetId?: string }>([...(current?.objects ?? []), ...nodes].map(node => [node.id, node]));
  const edges = plan.edges.map(edge => {
    const { quote, sources } = supportingSources(edge.id, edge.evidenceIds, edgeProofs, evidence);
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (!from || !to || !edgeEndpointsMentioned(from, to, quote)) throw new Error("Connection endpoints are missing from its supporting quote: " + edge.id);
    if (sources.every(source => source.kind === "dependencies")) throw new Error("Dependencies do not establish a component relationship: " + edge.id);
    const corrected = { ...edge, evidenceIds: sources.map(source => source.id) };
    if (sources.every(source => source.kind === "compose" && source.origin !== "attachment")) {
      if (!/^startup dependency$/i.test(edge.label.trim()) || !sources.some(source => declaresStartupDependency(source, from, to))) {
        throw new Error("Compose connections must be declared startup dependencies: " + edge.id);
      }
      corrected.label = "Startup dependency";
      corrected.certainty = "declared";
    } else if (corrected.certainty === "declared" && sources.every(source => source.kind === "documentation" || source.kind === "source" || source.origin === "attachment")) corrected.certainty = "documented";
    return corrected;
  });
  return { ...plan, nodes, edges };
}
