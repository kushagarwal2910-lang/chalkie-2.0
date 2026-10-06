import type { LessonPlan } from "../lesson-schema";
import type { Explanation } from "./explanation";
import { RepositoryError, type Evidence, type RepositoryIndex } from "./types";

function excerpt(source: Evidence) {
  // Display/narrate repository text as a quotation, never as an instruction.
  const text = source.text.replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ").replace(/^[#>*\s-]+/gm, "").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
  return text.length > 260 ? text.slice(0, 257) + "…" : text || "This file provides indexed architecture evidence.";
}

/** A visibly limited, deterministic source walkthrough when model output is unusable. */
export function basicExplanation(index: RepositoryIndex, evidence: Evidence[], current?: LessonPlan): Explanation {
  if (!evidence.length) throw new RepositoryError("No readable evidence is available for this explanation. Add supporting documentation.", "NO_BLUEPRINTS");
  const prefix = "basic_" + crypto.randomUUID().slice(0, 8) + "_";
  const byPath = new Map<string, Evidence>();
  for (const source of evidence) if (!byPath.has(source.path)) byPath.set(source.path, source);
  const sources = [...byPath.values()].slice(0, 4);
  if (current?.objects.length) {
    const selected = sources.slice(0, 2);
    const steps = selected.map((source, i) => {
      const target = current.objects.find(node => node.evidenceIds?.includes(source.id)) ?? current.objects[0];
      return { id: prefix + "step" + i, title: ("Source: " + source.path.split("/").pop()).slice(0, 100),
        narration: (i === 0 ? "This basic response shows the closest source excerpts; they may not fully answer your question. " : "") + "The indexed excerpt from " + source.path.slice(0, 180) + " says: “" + excerpt(source) + "”",
        targetIds: [target.id], action: "focus" as const, durationMs: 18000 };
    });
    return { title: "Related source excerpts", summary: "Basic source response: the AI answer could not be validated. These are related indexed excerpts, not a verified answer to your question. The existing diagram is preserved.",
      coverage: "existing", nodes: [], edges: [], steps, targetIds: [...new Set(steps.flatMap(step => step.targetIds))] };
  }

  const nodes: Explanation["nodes"] = [];
  const edges: Explanation["edges"] = [];
  // Compose service declarations are structured facts. Do not infer request
  // flows from ports, network membership, libraries, or documentation wording.
  const services = new Map<string, { node: Explanation["nodes"][number]; source: Evidence; dependsOn: string[] }>();
  for (const source of evidence) {
    if (source.kind !== "compose" || source.origin === "attachment" || services.size >= 4) continue;
    const match = source.text.match(/^service ([^:]+): (\{[\s\S]*\})$/);
    if (!match) continue;
    try {
      const value = JSON.parse(match[2]) as { image?: unknown; depends_on?: unknown };
      const name = match[1];
      const node: Explanation["nodes"][number] = { id: prefix + "node" + nodes.length, kind: "container", label: name.slice(0, 90),
        description: ("Service declared in " + source.path + (typeof value.image === "string" ? ". Image: " + value.image : ". Runtime behavior is not verified.")).slice(0, 400),
        group: "Declared containers", assetId: "tech:docker", evidenceIds: [source.id], certainty: "declared" };
      const deps = Array.isArray(value.depends_on) ? value.depends_on.filter((v): v is string => typeof v === "string")
        : value.depends_on && typeof value.depends_on === "object" ? Object.keys(value.depends_on) : [];
      const key = source.path + "\0" + name;
      if (services.has(key)) continue;
      services.set(key, { node, source, dependsOn: deps }); nodes.push(node);
    } catch { /* Truncated or unrecognized evidence stays a document excerpt. */ }
  }
  for (const { node, source, dependsOn } of services.values()) {
    for (const dependency of dependsOn) {
      const other = services.get(source.path + "\0" + dependency)?.node;
      if (!other || node.id === other.id || edges.length >= 6) continue;
      edges.push({ id: prefix + "edge" + edges.length, from: node.id, to: other.id, label: "Startup dependency", evidenceIds: [source.id], certainty: "declared" });
    }
  }
  for (const source of sources) {
    if (nodes.length >= 4) break;
    if (nodes.some(node => node.evidenceIds.includes(source.id))) continue;
    nodes.push({ id: prefix + "node" + nodes.length, kind: "document", label: (source.path.split("/").pop() || "Source document").slice(0, 90),
      description: ("Indexed excerpt: “" + excerpt(source) + "”").slice(0, 400), group: "Indexed sources", assetId: "concept:document", evidenceIds: [source.id], certainty: "documented" });
  }
  const steps: Explanation["steps"] = nodes.map((node, i) => {
    const source = evidence.find(item => item.id === node.evidenceIds[0])!;
    const dependencies = edges.filter(edge => edge.from === node.id).map(edge => nodes.find(other => other.id === edge.to)!.label);
    const dependents = edges.filter(edge => edge.to === node.id).map(edge => nodes.find(other => other.id === edge.from)!.label);
    const behavior = dependencies.length ? node.label + " lists " + dependencies.join(" and ") + " as startup prerequisites. This declaration tells Compose how these services are ordered when starting the project."
      : dependents.length ? dependents.join(" and ") + " list " + node.label + " as a startup prerequisite. That puts this service earlier in the declared startup sequence."
      : "Compose defines " + node.label + " as a separate service. It is a named unit that can be configured and started as part of this project.";
    const linkedEdges = edges.filter(edge => edge.from === node.id).map(edge => edge.id);
    return { id: prefix + "step" + i, title: node.label, narration: (i === 0 ? "This is a basic walkthrough of indexed sources. " + (services.size ? "The connections show startup dependencies, not verified request flows. " : "") : "") + (node.kind === "container"
      ? behavior
      : "The indexed excerpt from " + source.path.slice(0, 180) + " says: “" + excerpt(source) + "”"), targetIds: linkedEdges.length ? [node.id, ...linkedEdges.slice(0, 2)] : [node.id], action: linkedEdges.length ? "trace" : "reveal", durationMs: 18000 };
  });
  return { title: (index.repository.name + " · basic source overview").slice(0, 150), summary: "Basic source overview: the AI explanation could not be validated, so this walkthrough uses indexed declarations and excerpts directly. It does not infer missing architecture or verify deployed behavior.",
    coverage: "append", nodes, edges, steps, targetIds: nodes.slice(0, 3).map(node => node.id) };
}
