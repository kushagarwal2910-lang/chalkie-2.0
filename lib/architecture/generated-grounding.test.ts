import assert from "node:assert/strict";
import test from "node:test";
import type { LessonPlan } from "../lesson-schema.ts";
import type { Explanation } from "./explanation.ts";
import { validateGeneratedGrounding, type GeneratedGroundingProofs } from "./generated-grounding.ts";
import type { Evidence } from "./types.ts";

const source = (text: string, extra: Partial<Evidence> = {}): Evidence => ({ id: "e1", path: "README.md", startLine: 1, endLine: 5, kind: "documentation", text, ...extra });
function fixture(): { plan: Explanation; proofs: GeneratedGroundingProofs; evidence: Evidence[] } {
  const quote = "The API sends each task to the worker, which processes it.";
  return {
    plan: { title: "Task processing", summary: "A documented workflow", coverage: "append", nodes: [
      { id: "api", label: "API service", kind: "service", description: "Accepts tasks", group: "Processing", assetId: "concept:service", certainty: "documented", evidenceIds: ["e1"] },
      { id: "worker", label: "Worker", kind: "worker", description: "Processes tasks", group: "Processing", assetId: "concept:worker", certainty: "documented", evidenceIds: ["e1"] },
    ], edges: [{ id: "tasks", from: "api", to: "worker", label: "Sends tasks", certainty: "documented", evidenceIds: ["e1"] }], steps: [{ id: "step", title: "Task flow", narration: "The API accepts a task and passes it to the worker. The worker processes it.", targetIds: ["tasks"], action: "trace", durationMs: 10000 }], targetIds: ["api"] },
    proofs: { nodes: [{ id: "api", supportingQuote: quote }, { id: "worker", supportingQuote: quote }], edges: [{ id: "tasks", supportingQuote: quote }] },
    evidence: [source(quote)],
  };
}

test("documented relationships require real quotes and both named endpoints", () => {
  const { plan, proofs, evidence } = fixture();
  assert.deepEqual(validateGeneratedGrounding(plan, proofs, evidence), plan);
  const invented = structuredClone(proofs); invented.edges[0].supportingQuote = "The API stores tasks in a database.";
  assert.throws(() => validateGeneratedGrounding(plan, invented, evidence), /does not match cited evidence/);
  const shortened = structuredClone(proofs); shortened.edges[0].supportingQuote = "The API sends each task";
  assert.throws(() => validateGeneratedGrounding(plan, shortened, evidence), /endpoints are missing/);
});

test("valid source IDs and vendor icons cannot launder invented component names", () => {
  const { plan, proofs, evidence } = fixture();
  plan.nodes[0].label = "Billing API"; plan.nodes[0].assetId = "tech:redis";
  assert.throws(() => validateGeneratedGrounding(plan, proofs, evidence), /Node identity is missing/);
  const missing = fixture(); missing.proofs.nodes = missing.proofs.nodes.slice(1);
  assert.throws(() => validateGeneratedGrounding(missing.plan, missing.proofs, missing.evidence), /Missing supporting quote/);
});

test("only the evidence containing the proof can affect certainty and vendor icons", () => {
  const { plan, proofs, evidence } = fixture();
  evidence.push(source('service db: {"image":"redis:7"}', { id: "infra", kind: "compose" }));
  plan.nodes[0].certainty = "declared"; plan.nodes[0].assetId = "tech:redis"; plan.nodes[0].evidenceIds.push("infra");
  plan.edges[0].certainty = "declared";
  const result = validateGeneratedGrounding(plan, proofs, evidence);
  assert.equal(result.nodes[0].certainty, "documented"); assert.equal(result.nodes[0].assetId, "concept:service");
  assert.deepEqual(result.nodes[0].evidenceIds, ["e1"]); assert.equal(result.edges[0].certainty, "documented");
  assert.equal(plan.nodes[0].certainty, "declared"); assert.equal(plan.nodes[0].assetId, "tech:redis");
});

test("dependency manifests establish packages, never relationships between them", () => {
  const { plan, proofs, evidence } = fixture();
  evidence[0].kind = "dependencies";
  assert.throws(() => validateGeneratedGrounding(plan, proofs, evidence), /Dependencies do not establish/);
  plan.edges = []; proofs.edges = [];
  const result = validateGeneratedGrounding(plan, proofs, evidence);
  assert.ok(result.nodes.every(node => node.kind === "unknown"));
});

function composeFixture() {
  const data = fixture();
  const quote = 'service api: {"depends_on":["worker"],"networks":["internal"]}';
  data.evidence = [source(quote, { path: "compose.yaml", kind: "compose" })];
  for (const proof of [...data.proofs.nodes, ...data.proofs.edges]) proof.supportingQuote = quote;
  data.plan.edges[0].label = "Startup dependency";
  return data;
}

test("Compose startup relationships must match the declared direction and dependency", () => {
  const { plan, proofs, evidence } = composeFixture();
  const result = validateGeneratedGrounding(plan, proofs, evidence);
  assert.equal(result.edges[0].certainty, "declared"); assert.equal(result.edges[0].label, "Startup dependency");
  plan.edges[0].from = "worker"; plan.edges[0].to = "api";
  assert.throws(() => validateGeneratedGrounding(plan, proofs, evidence), /declared startup dependencies/);
});

test("Compose ports and network membership cannot become request flow or startup edges", () => {
  const { plan, proofs, evidence } = composeFixture();
  plan.edges[0].label = "Sends tasks";
  assert.throws(() => validateGeneratedGrounding(plan, proofs, evidence), /declared startup dependencies/);
  plan.edges[0].label = "Startup dependency";
  evidence[0].text = 'service api: {"networks":["worker"]}';
  for (const proof of [...proofs.nodes, ...proofs.edges]) proof.supportingQuote = evidence[0].text;
  assert.throws(() => validateGeneratedGrounding(plan, proofs, evidence), /declared startup dependencies/);
});

test("Compose object dependencies work but incomplete structured evidence fails closed", () => {
  const { plan, proofs, evidence } = composeFixture();
  evidence[0].text = 'service api: {"depends_on":{"worker":{"condition":"service_healthy"}}}';
  for (const proof of [...proofs.nodes, ...proofs.edges]) proof.supportingQuote = evidence[0].text;
  assert.equal(validateGeneratedGrounding(plan, proofs, evidence).edges.length, 1);
  evidence[0].text = 'service api: {"depends_on":{"worker":';
  for (const proof of [...proofs.nodes, ...proofs.edges]) proof.supportingQuote = evidence[0].text;
  assert.throws(() => validateGeneratedGrounding(plan, proofs, evidence), /declared startup dependencies/);
});

test("follow-up edges may reference current nodes but must prove both identities", () => {
  const { plan, proofs, evidence } = fixture();
  const current = { objects: plan.nodes } as unknown as LessonPlan;
  plan.nodes = []; proofs.nodes = [];
  assert.equal(validateGeneratedGrounding(plan, proofs, evidence, current).edges.length, 1);
  assert.throws(() => validateGeneratedGrounding(plan, proofs, evidence), /endpoints are missing/);
});

test("duplicate proof IDs and attachment declaration claims cannot bypass checks", () => {
  const { plan, proofs, evidence } = fixture();
  plan.edges[0].certainty = "declared"; evidence[0].origin = "attachment"; evidence[0].kind = "compose";
  assert.equal(validateGeneratedGrounding(plan, proofs, evidence).edges[0].certainty, "documented");
  proofs.nodes = [...proofs.nodes, proofs.nodes[0]];
  assert.throws(() => validateGeneratedGrounding(plan, proofs, evidence), /Duplicate grounding proof/);
});
