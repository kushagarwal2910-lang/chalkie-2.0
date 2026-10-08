import assert from "node:assert/strict";
import test from "node:test";
import { createRepositoryLesson, createRepositoryFollowUp, validateGeneratedExplanation } from "./explanation";
import { defaultExplanationFocus, effectiveExplanationFocus } from "./teaching-focus";
import type { Evidence, RepositoryIndex } from "./types";

const statement = "Browser sends a request to API. API returns the result to Browser.";
const source: Evidence = { id: "readme", path: "README.md", startLine: 1, endLine: 8, kind: "documentation", text: statement };
const repository = (): RepositoryIndex => ({ version: 1, id: "teaching", ownerKey: "test", createdAt: new Date().toISOString(), repository: { owner: "team", name: "project", url: "https://github.com/team/project", commit: "a".repeat(40) }, discoveredFiles: 1, files: [{ path: source.path, kind: source.kind, bytes: source.text.length }], evidence: [source], warnings: [] });
const response = () => ({
  title: "Follow the request", summary: "A documented request and response.", coverage: "append",
  nodes: ["Browser", "API"].map((label, i) => ({ id: "n" + i, label, kind: i ? "service" : "browser", group: "Request", description: i ? "Returns the result" : "Sends the request", assetId: i ? "concept:service" : "concept:browser", evidenceIds: [source.id], certainty: "documented", supportingQuote: statement })),
  edges: [{ id: "request", from: "n0", to: "n1", label: "Sends request", evidenceIds: [source.id], certainty: "documented", supportingQuote: statement }],
  steps: [{ id: "s1", title: "Follow the handoff", narration: "Browser sends a request to API. Follow the arrow as that request moves between the components; API then returns the result to Browser, completing this documented exchange.", targetIds: ["request"], action: "trace", durationMs: 18000 }], targetIds: ["request"],
});

test("bare URLs use the engineer default and custom focus overrides it without becoming evidence", async () => {
  assert.match(defaultExplanationFocus(), /engineer joining the team/);
  assert.match(defaultExplanationFocus("leadership"), /nontechnical leader/);
  assert.equal(effectiveExplanationFocus("  Explain ownership  ", "developer"), "Explain ownership");
  for (const custom of [undefined, "Explain ownership"]) {
    const index = { ...repository(), instructions: custom };
    let calls = 0;
    const lesson = await createRepositoryLesson(index, "developer", {}, async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init.body));
      const context = JSON.parse(request.messages[1].content);
      assert.equal(context.explanationFocus, custom ?? defaultExplanationFocus());
      assert.deepEqual(context.evidence.map((item: Evidence) => item.text), [statement]);
      return Response.json({ choices: [{ message: { content: JSON.stringify(response()) } }] });
    });
    assert.equal(calls, 1);
    assert.equal(lesson.connections.length, 1);
    assert.equal(JSON.stringify(lesson).includes("supportingQuote"), false);
  }
});

test("a real source ID cannot justify an invented component, quote, or caption-only lesson", () => {
  const fabricated = response(); fabricated.nodes[1].label = "Billing Engine";
  assert.throws(() => validateGeneratedExplanation(fabricated, [source]), /identity/);
  const quote = response(); quote.edges[0].supportingQuote = "Browser calls Billing Engine.";
  assert.throws(() => validateGeneratedExplanation(quote, [source]), /quote/);
  const reading = response(); reading.steps[0].targetIds = ["n0", "n1"]; reading.steps[0].narration = "Sends the request. Returns the result.";
  assert.throws(() => validateGeneratedExplanation(reading, [source]), /captions/);
  reading.steps[0].narration = "Here, Browser sends the request.";
  assert.throws(() => validateGeneratedExplanation(reading, [source]), /too brief/);
  assert.equal(validateGeneratedExplanation(response(), [source]).steps[0].action, "trace");
});

test("an overview preserves its introduction and whole useful passages within the existing request budget", async () => {
  const index = repository();
  index.evidence.push(...Array.from({ length: 18 }, (_, i) => ({ ...source, id: "detail" + i, path: "docs/architecture/adr-" + i + ".md", text: "Purpose architecture services entry components workflow starting point output. ".repeat(15) + "The diagram must retain this complete final sentence." })));
  const original = structuredClone(index.evidence);
  await createRepositoryLesson(index, "developer", {}, async (_url, init) => {
    const body = String(init.body), request = JSON.parse(body), context = JSON.parse(request.messages[1].content);
    assert.ok(Buffer.byteLength(body) <= 14000);
    assert.equal(request.max_completion_tokens, 3000);
    assert.ok(context.evidence.some((item: Evidence) => item.id === source.id));
    assert.ok(context.evidence.length > 1 && context.evidence.length < index.evidence.length);
    for (const item of context.evidence) assert.equal(item.text, original.find(source => source.id === item.id)!.text);
    return Response.json({ choices: [{ message: { content: JSON.stringify(response()) } }] });
  });
  assert.deepEqual(index.evidence, original);
});

test("follow-up context retains the source of an existing connection", async () => {
  const index = repository();
  const lesson = await createRepositoryLesson(index, "developer", {}, async () => Response.json({ choices: [{ message: { content: JSON.stringify(response()) } }] }));
  lesson.connections[0].evidenceIds = ["edge-source"];
  index.evidence.push({ ...source, id: "edge-source", path: "docs/flow.md", startLine: 20 });
  index.evidence.push(...Array.from({ length: 20 }, (_, i) => ({ ...source, id: "other" + i, path: "docs/other-" + i + ".md", text: "Extra detail about architecture requests Browser API. ".repeat(25) })));
  let calls = 0;
  await createRepositoryFollowUp(index, "Explain the architecture request", lesson, "developer", {}, async (_url, init) => {
    calls++;
    const context = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
    assert.ok(context.evidence.some((item: Evidence) => item.id === "edge-source"));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ ...response(), coverage: "existing", nodes: [], edges: [], steps: [{ ...response().steps[0], id: "s2" }] }) } }] });
  });
  assert.equal(calls, 1);
});
