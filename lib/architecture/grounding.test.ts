import assert from "node:assert/strict";
import test from "node:test";
import { edgeEndpointsMentioned, enforceNodeGrounding, nodeIdentityMentioned, quoteMatchesEvidence } from "./grounding.ts";
import type { Evidence } from "./types.ts";

const source = (text: string, extra: Partial<Evidence> = {}): Evidence => ({ id: "e1", path: "README.md", startLine: 1, endLine: 5, kind: "documentation", text, ...extra });
const node = (extra: Record<string, unknown> = {}) => ({ id: "redis", label: "Redis cache", assetId: "tech:redis", kind: "cache", certainty: "declared" as const, evidenceIds: ["e1"], ...extra });

test("a catalog logo needs a bounded technology name in its own cited evidence", () => {
  assert.equal(enforceNodeGrounding(node(), [source("Redis stores cache entries.")]).assetId, "tech:redis");
  assert.equal(enforceNodeGrounding(node(), [source("The team is redistributing documents.")]).assetId, "concept:cache");
  assert.equal(enforceNodeGrounding(node(), [source("The API handles requests."), source("Redis is available.", { id: "unrelated" })]).assetId, "concept:cache");
  assert.equal(enforceNodeGrounding(node({ assetId: "tech:apache" }), [source("The API handles requests.")]).assetId, "concept:cache", "empty catalog aliases cannot match everything");
});

test("technology aliases handle declared images and resource names without substring guesses", () => {
  assert.equal(enforceNodeGrounding(node({ assetId: "tech:postgresql" }), [source('service db: {"image":"postgres:17"}', { kind: "compose" })]).assetId, "tech:postgresql");
  assert.equal(enforceNodeGrounding(node({ assetId: "tech:amazonwebservices" }), [source('resource aws_s3_bucket: {"files":{}}', { kind: "terraform" })]).assetId, "tech:amazonwebservices");
  assert.equal(enforceNodeGrounding(node({ assetId: "tech:go" }), [source("Go to the next page to begin.")]).assetId, "concept:cache");
  assert.equal(enforceNodeGrounding(node({ assetId: "tech:go" }), [source("The CLI is written in Go.")]).assetId, "tech:go");
});

test("dependency-only evidence cannot present installed packages as deployed infrastructure", () => {
  const original = node();
  const result = enforceNodeGrounding(original, [source('dependencies: {"redis":"5"}', { kind: "dependencies" })]);
  assert.equal(result.kind, "unknown"); assert.equal(result.certainty, "documented"); assert.equal(result.assetId, "tech:redis");
  assert.equal(original.kind, "cache"); assert.equal(original.certainty, "declared");
  assert.equal(enforceNodeGrounding(node({ assetId: "concept:cache" }), [source('dependencies: {"redis":"5"}', { kind: "dependencies" })]).assetId, "concept:unknown");
});

test("documentation and attachment claims retain honest certainty", () => {
  assert.equal(enforceNodeGrounding(node(), [source("Redis caches values.")]).certainty, "documented");
  assert.equal(enforceNodeGrounding(node(), [source("Redis caches values.", { kind: "compose", origin: "attachment" })]).certainty, "documented");
  assert.equal(enforceNodeGrounding(node(), [source('service cache: {"image":"redis:7"}', { kind: "compose" })]).certainty, "declared");
  assert.equal(enforceNodeGrounding(node({ certainty: "inferred" }), [source("Redis caches values.")]).certainty, "inferred");
  assert.equal(enforceNodeGrounding(node(), []).certainty, "unknown");
});

test("support quotes must be an exact span inside a single cited source", () => {
  const evidence = [source("The API\n sends  jobs to a worker."), source("The worker stores results.", { id: "e2" })];
  assert.ok(quoteMatchesEvidence("API sends jobs to a worker", ["e1"], evidence));
  assert.equal(quoteMatchesEvidence("The API sends jobs and stores results.", ["e1", "e2"], evidence), false);
  assert.equal(quoteMatchesEvidence("The worker stores results.", ["e1"], evidence), false);
  assert.equal(quoteMatchesEvidence("", ["e1"], evidence), false);
  assert.equal(quoteMatchesEvidence("the api sends jobs", ["e1"], evidence), false, "quotes are exact except whitespace");
});

test("node identity accepts role suffixes and real aliases but not an unrelated logo", () => {
  assert.ok(nodeIdentityMentioned({ label: "API service", assetId: "concept:service" }, 'service api: {"depends_on":["db"]}'));
  assert.ok(nodeIdentityMentioned({ label: "PostgreSQL database", assetId: "tech:postgresql" }, 'image: "postgres:17"'));
  assert.equal(nodeIdentityMentioned({ label: "Billing API", assetId: "tech:redis" }, "Redis caches values."), false);
  assert.equal(nodeIdentityMentioned({ label: "API", assetId: "concept:service" }, "The capital is named in documentation."), false);
  assert.equal(nodeIdentityMentioned({ label: "Main service", assetId: "concept:service" }, "Main configuration file."), false);
});

test("edge endpoint checks require both identities in the relationship excerpt", () => {
  const from = { label: "API service", assetId: "concept:service" };
  const to = { label: "Worker", assetId: "concept:worker" };
  assert.ok(edgeEndpointsMentioned(from, to, "The API submits each task to the worker."));
  assert.equal(edgeEndpointsMentioned(from, to, "The API receives incoming requests."), false);
});

test("spoken code identifiers preserve entity identity without combining unrelated words", () => {
  const identity = { label: "Create job", assetId: "concept:service" };
  assert.ok(nodeIdentityMentioned(identity, "def create_job(request): return queue.submit(request)"));
  assert.ok(nodeIdentityMentioned(identity, "function createJob(request) { return submit(request); }"));
  assert.equal(nodeIdentityMentioned(identity, "create_user(request); enqueue_job(request);"), false);
  assert.equal(nodeIdentityMentioned({ ...identity, label: "Billing worker" }, "create_job(request);"), false);
});

test("static source evidence does not establish a deployed resource", () => {
  const result = enforceNodeGrounding(node(), [source("const client = new Redis();", { kind: "source", path: "src/cache.ts" })]);
  assert.equal(result.certainty, "documented");
  assert.equal(result.assetId, "tech:redis");
});
