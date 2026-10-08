import type { LessonPlan } from "../lesson-schema";
import type { Explanation } from "./explanation";
import { RepositoryError, type Evidence, type RepositoryIndex } from "./types";

function excerpt(source: Evidence) {
  // Keep source text in the inspector, never recite it as the explanation.
  const text = source.text.replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ").replace(/^[#>*\s-]+/gm, "").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
  return text.length > 260 ? text.slice(0, 257) + "…" : text || "This file provides indexed architecture evidence.";
}

function sourceOrientation(source: Evidence): string {
  if (source.origin === "attachment") return "This supporting document gives you context supplied with the question. Open its source to inspect that context alongside the repository's own declarations.";
  switch (source.kind) {
    case "compose": return "This configuration is where you inspect how containers are set up together. Open its source to check the declarations before treating any connection as a live request path.";
    case "docker": return "A container definition describes the environment an application starts in. It is a useful place to inspect startup settings before you trace what the application itself does.";
    case "dependencies": return "The dependency manifest tells you which software the project declares it needs. Use it to orient yourself in the toolchain; an installed library alone does not establish a running service.";
    case "terraform":
    case "cloudformation": return "Infrastructure declarations are a plan for resources and their configuration. They are a useful starting point for understanding deployment setup, while the deployed environment can differ from that plan.";
    case "kubernetes": return "These deployment declarations describe configuration for Kubernetes. Open their sources to inspect the workloads and settings before tracing application behavior.";
    default: return "This project guide is a starting point for the team's written instructions. Open its source to find the documented setup or usage steps before assuming how components interact.";
  }
}

function documentNode(prefix: string, position: number, source: Evidence): Explanation["nodes"][number] {
  return { id: prefix + "node" + position, kind: "document", label: (source.path.split("/").pop() || "Source document").slice(0, 90),
    description: ("Source reference: “" + excerpt(source) + "”").slice(0, 400), group: "Indexed sources", assetId: "concept:document", evidenceIds: [source.id], certainty: "documented" };
}

/** A visibly limited, deterministic source walkthrough when model output is unusable. */
export function basicExplanation(index: RepositoryIndex, evidence: Evidence[], current?: LessonPlan): Explanation {
  if (!evidence.length) throw new RepositoryError("No readable evidence is available for this explanation. Add supporting documentation.", "NO_BLUEPRINTS");
  const prefix = "basic_" + crypto.randomUUID().slice(0, 8) + "_";
  const byPath = new Map<string, Evidence>();
  for (const source of evidence) if (!byPath.has(source.path)) byPath.set(source.path, source);
  const sources = [...byPath.values()].slice(0, 4);
  if (current?.objects.length) {
    // The retrieved evidence can concern a component that is not on the current
    // board. Never make the first unrelated node look like an answer to it.
    const target = evidence.flatMap(source => current.objects.filter(node => node.evidenceIds?.includes(source.id)))[0];
    if (!target && current.objects.length >= 160) throw new RepositoryError("The diagram is full. Start a new walkthrough to inspect this additional source.", "DIAGRAM_CAPACITY");
    const nodes = target ? [] : [documentNode(prefix, 0, sources[0])];
    const targetId = target?.id ?? nodes[0].id;
    return { title: "Basic source reference", summary: "Basic source response: the AI answer could not be validated. This is a source reference, not a verified answer to your question. The existing diagram is preserved.",
      coverage: target ? "existing" : "append", nodes, edges: [],
      steps: [{ id: prefix + "step0", title: "Inspect the related source",
        narration: "I couldn't verify an answer to that question. " + (target ? "I've highlighted the related component; open its sources to inspect the available evidence." : "I've added the closest source as a document on the canvas, so you can inspect the available evidence."),
        targetIds: [targetId], action: "focus", durationMs: 13000 }], targetIds: [targetId] };
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
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,89}$/.test(name)) continue;
      const node: Explanation["nodes"][number] = { id: prefix + "node" + nodes.length, kind: "container", label: name.slice(0, 90),
        description: ("Service declared in " + source.path + (typeof value.image === "string" ? ". Image: " + value.image : ". Runtime behavior is not verified.")).slice(0, 400),
        group: "Declared containers", assetId: "tech:docker", evidenceIds: [source.id], certainty: "declared" };
      const deps = Array.isArray(value.depends_on) ? value.depends_on.filter((v): v is string => typeof v === "string")
        : value.depends_on && typeof value.depends_on === "object" ? Object.keys(value.depends_on) : [];
      const key = source.path + "\0" + name;
      if (services.has(key)) continue;
      services.set(key, { node, source, dependsOn: deps }); nodes.push(node);
    } catch { /* Truncated or unrecognized evidence stays a source reference. */ }
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
    // One source orientation per file class avoids repeating generic advice for
    // several documentation excerpts as if each were a substantive answer.
    if (nodes.some(node => node.kind === "document" && evidence.some(item => node.evidenceIds.includes(item.id) && item.kind === source.kind && item.origin === source.origin))) continue;
    nodes.push(documentNode(prefix, nodes.length, source));
  }
  const steps: Explanation["steps"] = nodes.map((node, i) => {
    const source = evidence.find(item => item.id === node.evidenceIds[0])!;
    const dependencies = edges.filter(edge => edge.from === node.id).map(edge => nodes.find(other => other.id === edge.to)!.label);
    const dependents = edges.filter(edge => edge.to === node.id).map(edge => nodes.find(other => other.id === edge.from)!.label);
    const behavior = dependencies.length ? node.label + " depends on " + dependencies.join(" and ") + " during startup. Follow this connection to see which services Compose considers before starting it."
      : dependents.length ? "Start with " + node.label + ". " + dependents.join(" and ") + " depend on it during startup, which puts it earlier in their declared startup sequence."
      : "Compose defines " + node.label + " as a separate service. It is a named unit that can be configured and started as part of this project.";
    const linkedEdges = edges.filter(edge => edge.from === node.id).map(edge => edge.id);
    return { id: prefix + "step" + i, title: node.label, narration: (i === 0 ? "Let's use a basic source overview to get our bearings. " + (services.size ? "These connections show startup dependencies, not request traffic. " : "") : "") + (node.kind === "container"
      ? behavior
      : sourceOrientation(source)), targetIds: linkedEdges.length ? [node.id, ...linkedEdges.slice(0, 2)] : [node.id], action: linkedEdges.length ? "trace" : "reveal", durationMs: 18000 };
  });
  return { title: (index.repository.name + " · basic source overview").slice(0, 150), summary: "Basic source overview: the AI explanation could not be validated. This limited orientation shows parsed declarations and where to inspect the original sources; it does not establish missing architecture or application behavior.",
    coverage: "append", nodes, edges, steps, targetIds: nodes.slice(0, 3).map(node => node.id) };
}
