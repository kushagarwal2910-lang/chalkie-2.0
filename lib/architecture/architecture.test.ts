import assert from "node:assert/strict";
import test from "node:test";
import { classifyBlueprint, parseBlueprint, redactSecrets } from "./blueprints.ts";
import { ingestRepository, parseRepositoryUrl, retrieveEvidence } from "./github.ts";
import { collisionFreePosition, layoutArchitecture, overlap } from "./layout.ts";
import { assetCatalog, searchAssets } from "./assets.ts";
import { validateExplanation, createRepositoryLesson, createRepositoryFollowUp } from "./explanation.ts";
import { importArchitectureDocument } from "./document.ts";
import { lessonPlanSchema, followUpPlanSchema } from "../lesson-schema.ts";
import { saveRepositoryIndex, loadRepositoryIndex, clearRepositoryIndexes } from "./index-store.ts";
import { mkdtemp, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { mergeFollowUpLesson } from "../follow-up.ts";
import type { LessonPlan, FollowUpPlan } from "../lesson-schema.ts";
import type { Evidence, RepositoryIndex } from "./types.ts";
import { withSupportingContext } from "./supporting-context.ts";
import { repositoryInputSchema } from "../repository-input.ts";
import { githubFailure } from "./github-errors.ts";
import { providerFailure } from "../provider-response.ts";

test("blueprint allowlist excludes application source, secrets, state, symlinks and vendored content", () => {
  for (const path of ["app.ts", "auth.py", "lib/utils.js", "src/page.tsx", ".env", ".env.production", "terraform.tfstate", "terraform.tfstate.backup", "secrets.yaml", "node_modules/a/package.json", ".terraform/mod/main.tf", "pnpm-lock.yaml"]) {
    assert.equal(classifyBlueprint(path), null, path);
  }
  assert.equal(classifyBlueprint("services/api/Dockerfile"), "docker");
  assert.equal(classifyBlueprint("infra/main.tf"), "terraform");
  assert.equal(classifyBlueprint("services/api/package.json"), "dependencies");
  assert.equal(parseBlueprint("ci.yaml", "name: test\njobs: {}\n").evidence.length, 0);
});

test("Compose preserves declaration meanings without exposing environment secrets", () => {
  const parsed = parseBlueprint("compose.yaml", "services:\n  api:\n    image: team/api\n    ports: ['3000:3000']\n    depends_on: [db]\n    environment:\n      PASSWORD: do-not-index-this\n  db:\n    image: postgres:16\nnetworks:\n  backend: {}\n");
  const text = JSON.stringify(parsed.evidence);
  assert.equal(parsed.kind, "compose"); assert.match(text, /postgres:16/); assert.match(text, /depends_on/); assert.doesNotMatch(text, /do-not-index-this/);
});

test("Docker and HCL parsers extract actual declarations and keep variable references", () => {
  assert.match(JSON.stringify(parseBlueprint("Dockerfile", "FROM node:22\nEXPOSE 3000\nRUN echo never-execute\nENV SECRET=hidden\n").evidence), /EXPOSE 3000/);
  const hcl = parseBlueprint("infra/main.tf", 'resource "aws_s3_bucket" "uploads" {\n bucket = var.bucket_name\n}\n');
  assert.equal(hcl.warnings.filter(w => w.includes("could not parse")).length, 0);
  assert.match(JSON.stringify(hcl.evidence), /aws_s3_bucket/);
  assert.match(JSON.stringify(hcl.evidence), /bucket_name/);
  assert.ok(hcl.warnings.some(w => w.includes("unresolved")));
});

test("Kubernetes secret payloads and sensitive Terraform values never enter evidence", () => {
  const secret = parseBlueprint("k8s/resources.yaml", "apiVersion: v1\nkind: Secret\nmetadata:\n  name: app-key\ndata:\n  config: c2Vuc2l0aXZl\n");
  assert.doesNotMatch(JSON.stringify(secret), /c2Vuc2l0aXZl/);
  const tf = parseBlueprint("main.tf", 'variable "credential" {\n type = string\n sensitive = true\n default = "super-private"\n}\n');
  assert.doesNotMatch(JSON.stringify(tf), /super-private/);
  assert.doesNotMatch(redactSecrets("postgres://admin:pass@db:5432/x\nAPI_KEY=abc123\n"), /admin:pass|abc123/);
});

test("malformed blueprints produce coverage notes, never raw fallback context", () => {
  const parsed = parseBlueprint("compose.yaml", "services: [\n password: do-not-return");
  assert.equal(parsed.evidence.length, 0); assert.equal(parsed.warnings.length, 1); assert.doesNotMatch(JSON.stringify(parsed), /do-not-return/);
});

test("GitHub URL validation rejects SSRF and accepts branch names containing slashes", () => {
  for (const url of ["http://github.com/org/repo", "https://localhost/org/repo", "https://github.com.evil.test/org/repo", "https://user:pass@github.com/org/repo", "https://github.com/org/repo/blob/main/app.ts"]) assert.throws(() => parseRepositoryUrl(url));
  assert.equal(parseRepositoryUrl("https://github.com/org/repo/tree/feature/docs").ref, "feature/docs");
});

test("ingestion pins blobs to a commit and never downloads application code", async () => {
  const urls: string[] = [];
  const commit = "a".repeat(40);
  const content = JSON.stringify({ name: "api", dependencies: { next: "16", redis: "5" } });
  const fetcher = (async (url: string | URL | Request) => {
    const path = String(url); urls.push(path);
    const data = path.endsWith("/repos/team/project") ? { default_branch: "main" } : path.includes("/commits/") ? { sha: commit, commit: { tree: { sha: "root" } } } : path.includes("/git/trees/") ? { truncated: false, tree: [{ path: "services/api/package.json", sha: "manifest", mode: "100644", type: "blob", size: content.length }, { path: "app.ts", sha: "private-business-logic", mode: "100644", type: "blob", size: 40000 }, { path: "README.md", sha: "symlink", mode: "120000", type: "blob", size: 100 }] } : { encoding: "base64", size: content.length, content: Buffer.from(content).toString("base64") };
    return Response.json(data);
  }) as typeof fetch;
  const index = await ingestRepository("https://github.com/team/project", { ownerKey: "test", fetcher });
  assert.equal(index.repository.commit, commit); assert.equal(index.files.length, 1);
  assert.ok(!urls.some(url => url.includes("private-business-logic") || url.includes("symlink")));
  assert.match(JSON.stringify(retrieveEvidence(index, "Redis")), /redis/);
});

test("truncated GitHub trees are traversed without silently dropping nested blueprints", async () => {
  const content = "# Architecture\nThe service is documented here.";
  const fetcher = (async (url: string | URL | Request) => {
    const path = String(url);
    const data = path.endsWith("/repos/a/b") ? { default_branch: "main" } : path.includes("/commits/") ? { sha: "b".repeat(40), commit: { tree: { sha: "root" } } } : path.endsWith("recursive=1") ? { truncated: true, tree: [] } : path.endsWith("/trees/root") ? { tree: [{ path: "docs", sha: "docs", type: "tree", mode: "040000" }] } : path.endsWith("/trees/docs") ? { tree: [{ path: "ARCHITECTURE.md", sha: "doc", type: "blob", mode: "100644", size: content.length }] } : { content: Buffer.from(content).toString("base64"), size: content.length, encoding: "base64" };
    return Response.json(data);
  }) as typeof fetch;
  const index = await ingestRepository("https://github.com/a/b", { ownerKey: "test", fetcher });
  assert.equal(index.files[0].path, "docs/ARCHITECTURE.md");
});

const evidence: Evidence[] = [{ id: "e1", path: "compose.yaml", startLine: 1, endLine: 5, kind: "compose", text: "api depends_on db" }];
const plan = () => ({ title: "System", summary: "Declared architecture", coverage: "append", nodes: [{ id: "api", kind: "service", label: "API", description: "Handles requests", group: "Backend", assetId: "concept:service", evidenceIds: ["e1"], certainty: "declared" }], edges: [], steps: [{ id: "step1", title: "API", narration: "This is the API.", targetIds: ["api"], action: "reveal", durationMs: 5000 }], targetIds: ["api"] });
test("model plans reject dangling edges, unknown evidence, ID collisions and untaught nodes", () => {
  assert.ok(validateExplanation(plan(), evidence));
  assert.throws(() => validateExplanation({ ...plan(), edges: [{ id: "e", from: "api", to: "missing", label: "calls", evidenceIds: ["e1"], certainty: "declared" }] }, evidence));
  const invalid = plan(); invalid.nodes[0].evidenceIds = ["invented"]; assert.throws(() => validateExplanation(invalid, evidence));
  const target = plan(); target.steps[0].targetIds = ["missing"]; assert.throws(() => validateExplanation(target, evidence));
  const unknownAsset = plan(); unknownAsset.nodes[0].assetId = "invented:logo";
  assert.equal(validateExplanation(unknownAsset, evidence).nodes[0].assetId, "concept:service");
});

export function fixtureLesson(): LessonPlan {
  return { schemaVersion: 2, revision: 0, id: "architecture-test", title: "A request through the platform", question: "https://github.com/example/platform", summary: "A fixture used to validate rendering.", diagramType: "system", visualStrategy: "Architecture test fixture", sources: [{ id: "e1", title: "compose.yaml:1", url: "https://github.com/example/platform/blob/" + "a".repeat(40) + "/compose.yaml#L1", publisher: "Test fixture", score: 1, summary: "Example declarations" }], objects: ["Web app", "API service", "Redis cache", "PostgreSQL", "Background worker"].map((label, i) => ({ id: "n" + i, label, description: ["The user-facing application.", "Coordinates requests across backend components.", "Caches reusable data.", "Persists application data.", "Processes asynchronous work."][i], group: i === 0 ? "Frontend" : "Backend", kind: ["browser", "service", "cache", "database", "worker"][i], assetId: ["tech:nextjs", "tech:nodejs", "tech:redis", "tech:postgresql", "tech:python"][i], evidenceIds: ["e1"], certainty: "declared", role: "component", shapeType: "custom", labelPlacement: "inside", x: 0, y: 0, width: 284, height: 170, parts: [] })), connections: [[0, 1, "Documented request"], [1, 2, "Startup dependency"], [1, 3, "Shares network"], [4, 3, "References database"]].map(([from, to, label], i) => ({ id: "c" + i, from: "n" + from, to: "n" + to, label: String(label), evidenceIds: ["e1"], certainty: "documented", color: "slate", route: "elbow", fromAnchor: "right", toAnchor: "left", arrowhead: "arrow", bend: 0 })), segments: [{ id: "s1", title: "The web application", narration: "The web application introduces the system to users.", targetIds: ["n0"], action: "reveal", durationMs: 5000 }, { id: "s2", title: "Backend services", narration: "The API communicates with these components as described in the blueprints.", targetIds: ["n1", "n2", "n3", "n4"], action: "reveal", durationMs: 5000 }] };
}
test("layout separates nodes and moving onto another node resolves the collision", async () => {
  const lesson = await layoutArchitecture(fixtureLesson());
  for (let i = 0; i < lesson.objects.length; i++) for (const other of lesson.objects.slice(i + 1)) assert.equal(overlap(lesson.objects[i], other, 0), false);
  for (const edge of lesson.connections) assert.ok(edge.points && edge.points.length >= 2);
  const node = lesson.objects[0], other = lesson.objects[1];
  const position = collisionFreePosition(node, other.x, other.y, lesson.objects);
  assert.equal(overlap({ ...node, ...position }, other), false);
});
test("follow-up merge preserves manual layout and rejects stale revisions", async () => {
  const current = await layoutArchitecture(fixtureLesson());
  current.view = { positions: { n0: { x: 123, y: 456 } } };
  const reply: FollowUpPlan = { id: "reply", baseRevision: 0, title: "More detail", answer: "Look at the API.", coverage: "existing", visualStrategy: "focus", objects: [], connections: [], targetIds: ["n1"], segments: [{ id: "s3", title: "API", narration: "Look at the API.", targetIds: ["n1"], action: "focus", durationMs: 4000 }] };
  const merged = mergeFollowUpLesson(current, reply);
  assert.equal(merged.lesson.objects[0].x, 123); assert.equal(merged.lesson.objects[0].y, 456); assert.equal(merged.startIndex, 2); assert.equal(merged.lesson.revision, 1);
  assert.throws(() => mergeFollowUpLesson({ ...current, revision: 1 }, reply), /diagram changed/);
});
test("asset lookup includes database aliases and the locally curated catalog", () => {
  assert.ok(assetCatalog.length > 200);
  assert.ok(searchAssets("postgres").some(a => a.id === "tech:postgresql"));
  assert.ok(searchAssets("aws").some(a => a.id === "tech:amazonwebservices"));
  assert.ok(searchAssets('"next": "16"').some(a => a.id === "tech:nextjs"));
});

test("CloudFormation intrinsic references survive parsing and sensitive defaults are removed", () => {
  const parsed = parseBlueprint("template.yaml", "Resources:\n  Bucket:\n    Type: AWS::S3::Bucket\n    Properties:\n      BucketName: !Sub '${Team}-uploads'\n      Tags:\n        - Key: team\n          Value: !Ref Team\n      Example: !Join [':', [!Ref Team, !GetAtt Other.Arn]]\nParameters:\n  Password:\n    NoEcho: true\n    Default: never-send-this\n");
  assert.equal(parsed.warnings.length, 0);
  assert.match(JSON.stringify(parsed.evidence), /Fn::Sub/);
  assert.match(JSON.stringify(parsed.evidence), /Fn::GetAtt/);
  assert.doesNotMatch(JSON.stringify(parsed.evidence), /never-send-this/);
});

test("JSON documents roundtrip view state and reject executable links or dangling targets", async () => {
  const original = await layoutArchitecture(fixtureLesson());
  original.view = { positions: {}, viewport: { x: 10, y: 20, zoom: .75 } };
  const roundtrip = importArchitectureDocument(JSON.stringify(original));
  assert.deepEqual(roundtrip.objects, original.objects);
  assert.deepEqual(roundtrip.view?.viewport, original.view.viewport);
  const invalid = structuredClone(original); invalid.sources[0].url = "javascript:alert(1)";
  assert.throws(() => importArchitectureDocument(JSON.stringify(invalid)), /HTTP/);
  invalid.sources = original.sources; invalid.segments[0].targetIds = ["missing"];
  assert.throws(() => importArchitectureDocument(JSON.stringify(invalid)), /missing component/);
});

function fixtureIndex(): RepositoryIndex {
  return { version: 1, id: "12345678-1234-4234-8234-123456789abc", ownerKey: "owner-a", repository: { owner: "example", name: "platform", url: "https://github.com/example/platform", commit: "a".repeat(40) }, createdAt: new Date().toISOString(), discoveredFiles: 1, files: [{ path: "compose.yaml", kind: "compose", bytes: 30 }], evidence, warnings: [] };
}

test("initial generation validates, repairs once, and produces a schema-valid grounded document", async () => {
  let requests = 0;
  const lesson = await createRepositoryLesson(fixtureIndex(), "leadership", {}, async (_path, init) => {
    requests++;
    const request = JSON.parse(String(init.body));
    assert.equal(request.response_format.type, "json_schema");
    assert.match(request.messages[0].content, /untrusted data/);
    assert.match(request.messages[0].content, /Audience: leadership/);
    return Response.json({ choices: [{ message: { content: requests === 1 ? '{"bad":"plan"}' : JSON.stringify(plan()) } }] });
  });
  assert.equal(requests, 2);
  assert.equal(lessonPlanSchema.parse(lesson).schemaVersion, 2);
  assert.match(lesson.sources[0].url, /\/blob\/a{40}\/compose.yaml#L1-L5$/);
  assert.ok(Number.isFinite(lesson.objects[0].x));
});

test("follow-up generation reuses context and can append a grounded component without moving existing nodes", async () => {
  const current = await layoutArchitecture(fixtureLesson());
  current.conversation = [{ question: "What is the API?", answer: "It coordinates requests." }];
  const output = { ...plan(), nodes: [{ ...plan().nodes[0], id: "extra", label: "Extra service" }], edges: [{ id: "extra-edge", from: "n1", to: "extra", label: "Documented dependency", evidenceIds: ["e1"], certainty: "documented" }], steps: [{ ...plan().steps[0], id: "extra-step", targetIds: ["extra-edge"] }], targetIds: ["extra"] };
  const reply = await createRepositoryFollowUp(fixtureIndex(), "Explain the extra service", current, "developer", {}, async (_path, init) => {
    const context = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
    assert.equal(context.current.conversation[0].question, "What is the API?");
    assert.equal(context.current.nodes.length, 5);
    return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
  });
  followUpPlanSchema.parse(reply);
  const merged = mergeFollowUpLesson(current, reply).lesson;
  assert.equal(merged.objects.length, 6);
  assert.deepEqual(merged.objects.slice(0, 5), current.objects);
  assert.ok(merged.objects.at(-1)!.x > Math.max(...current.objects.map(n => n.x + n.width)));
  const invalid = { ...plan(), coverage: "existing", nodes: [], steps: [{ ...plan().steps[0], id: "new-step", targetIds: ["s1"] }] };
  assert.throws(() => validateExplanation(invalid, evidence, current), /Invalid explanation target/);
});

test("private repository indexes persist, isolate browser owners, expire, and survive corrupt neighboring cache files", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chalkie-index-test-"));
  const previous = process.env.CHALKIE_DATA_DIR;
  process.env.CHALKIE_DATA_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.CHALKIE_DATA_DIR; else process.env.CHALKIE_DATA_DIR = previous;
    for (const file of await readdir(directory)) await rm(path.join(directory, file));
    await rmdir(directory);
  });
  const index = fixtureIndex();
  await writeFile(path.join(directory, "00000000-0000-0000-0000-000000000000.json"), "broken");
  await saveRepositoryIndex(index);
  assert.equal((await loadRepositoryIndex(index.id, "owner-a")).repository.name, "platform");
  await assert.rejects(loadRepositoryIndex(index.id, "owner-b"), /unavailable/);
  await clearRepositoryIndexes("owner-b");
  assert.ok(await loadRepositoryIndex(index.id, "owner-a"));
  await writeFile(path.join(directory, index.id + ".json"), JSON.stringify({ ...index, createdAt: "2020-01-01" }));
  await assert.rejects(loadRepositoryIndex(index.id, "owner-a"), /expired/);
  await clearRepositoryIndexes("owner-a");
  await assert.rejects(loadRepositoryIndex(index.id, "owner-a"), /unavailable/);
});

test("supporting documents are bounded, redacted and stored separately from task instructions", () => {
  assert.equal(repositoryInputSchema.safeParse({ documents: Array.from({ length: 6 }, () => ({ name: "a.txt", text: "hi" })) }).success, false);
  assert.equal(repositoryInputSchema.safeParse({ documents: [{ name: "../bad.txt", text: "hi" }] }).success, false);
  assert.equal(repositoryInputSchema.safeParse({ notes: "x".repeat(20001) }).success, false);
  assert.equal(repositoryInputSchema.safeParse({ documents: Array.from({ length: 5 }, () => ({ name: "a.txt", text: "x".repeat(20000) })) }).success, false);
  const input = repositoryInputSchema.parse({ instructions: "Focus on onboarding", notes: "Onboarding uses a buddy.\nAPI_KEY=private-value", documents: [{ name: "teams.md", text: "a".repeat(19000) }] });
  const index = withSupportingContext(fixtureIndex(), input);
  assert.equal(index.instructions, "Focus on onboarding");
  assert.doesNotMatch(JSON.stringify(index), /private-value/);
  const docs = index.evidence.filter(e => e.origin === "attachment");
  assert.ok(docs.every(e => e.text.length <= 2200));
  assert.equal(docs.filter(e => e.path === "teams.md").map(e => e.text).join("").length, 19000);
  assert.ok(!docs.some(e => e.text.includes("Focus on onboarding")));
  assert.equal(new Set(index.evidence.map(e => e.id)).size, index.evidence.length);
  assert.ok(retrieveEvidence(index, "onboarding").some(e => e.origin === "attachment"));
  const refreshed = withSupportingContext({ ...fixtureIndex(), id: "new-index" }, repositoryInputSchema.parse({}), index);
  assert.equal(refreshed.instructions, index.instructions);
  assert.deepEqual(refreshed.evidence.filter(e => e.origin === "attachment"), docs);
  assert.throws(() => withSupportingContext({ ...fixtureIndex(), ownerKey: "another-owner" }, repositoryInputSchema.parse({}), index), /another repository or owner/);
});

test("a repository without blueprints can use explicit supporting documentation but never scans source code", async () => {
  const fetcher = (async (url: string | URL | Request) => {
    const path = String(url);
    return Response.json(path.endsWith("/repos/a/b") ? { default_branch: "main" } : path.includes("/commits/") ? { sha: "a".repeat(40), commit: { tree: { sha: "root" } } } : { tree: [{ path: "app.ts", type: "blob", mode: "100644", sha: "source", size: 100 }] });
  }) as typeof fetch;
  await assert.rejects(ingestRepository("https://github.com/a/b", { ownerKey: "a", fetcher }), /Add supporting documentation/);
  const index = await ingestRepository("https://github.com/a/b", { ownerKey: "a", fetcher, allowEmptyEvidence: true });
  assert.equal(index.evidence.length, 0); assert.match(index.warnings[0], /supporting documentation/);
});

test("prompt and documents reach the overview and follow-up with honest attachment citations", async () => {
  const index = withSupportingContext(fixtureIndex(), repositoryInputSchema.parse({ instructions: "Explain team ownership for a new frontend engineer", documents: [{ name: "ownership.md", text: "The platform team owns the API gateway." }] }));
  const attachment = index.evidence.find(e => e.origin === "attachment")!;
  const output = plan(); output.nodes[0].evidenceIds = [attachment.id]; output.nodes[0].certainty = "documented";
  const complete = async (_path: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    const context = JSON.parse(request.messages[1].content);
    assert.equal(context.explanationFocus, index.instructions);
    assert.ok(context.evidence.some((e: Evidence) => e.id === attachment.id && e.origin === "attachment"));
    assert.match(request.messages[0].content, /not factual evidence/);
    return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
  };
  const lesson = await createRepositoryLesson(index, "developer", {}, complete);
  const source = lesson.sources.find(s => s.id === attachment.id)!;
  assert.equal(source.origin, "attachment"); assert.equal(source.url, ""); assert.match(source.publisher, /Supporting document/);
  assert.equal(importArchitectureDocument(JSON.stringify(lesson)).sources.find(s => s.id === source.id)?.origin, "attachment");
  const followup = { ...output, coverage: "existing", nodes: [], edges: [], steps: [{ ...output.steps[0], id: "followup-step", targetIds: [output.nodes[0].id] }] };
  const reply = await createRepositoryFollowUp(index, "Who owns this service?", lesson, "developer", {}, async (_path, init) => {
    const context = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
    assert.equal(context.explanationFocus, index.instructions);
    assert.ok(context.evidence.some((e: Evidence) => e.id === attachment.id));
    return Response.json({ choices: [{ message: { content: JSON.stringify(followup) } }] });
  });
  assert.ok(reply.sources?.some(s => s.id === attachment.id));
  const unsafe = structuredClone(lesson); unsafe.sources.find(s => s.id === source.id)!.url = "javascript:alert(1)";
  assert.throws(() => importArchitectureDocument(JSON.stringify(unsafe)), /HTTP/);
});

test("large documents and diagram history cannot grow the full Groq request past its budget", async () => {
  const index = withSupportingContext(fixtureIndex(), repositoryInputSchema.parse({ instructions: "Explain the architecture ".repeat(50), documents: Array.from({ length: 4 }, (_, i) => ({ name: `notes-${i}.md`, text: "Architecture owns the database. ".repeat(600) })) }));
  index.evidence.push(...Array.from({ length: 100 }, (_, i) => ({ ...evidence[0], id: "large" + i, text: "Repository architecture documentation. ".repeat(90) })));
  const current = fixtureLesson();
  current.objects = Array.from({ length: 160 }, (_, i) => ({ ...current.objects[0], id: "node" + i, label: "A long architecture component label ".repeat(2) }));
  current.connections = []; current.conversation = Array.from({ length: 30 }, () => ({ question: "question ".repeat(100), answer: "answer ".repeat(300) }));
  const output = { ...plan(), coverage: "existing", nodes: [], edges: [], targetIds: ["node0"], steps: [{ ...plan().steps[0], id: "followup", targetIds: ["node0"] }] };
  let calls = 0;
  await createRepositoryFollowUp(index, "Explain architecture", current, "developer", {}, async (_path, init) => {
    calls++;
    const body = String(init.body), request = JSON.parse(body), context = JSON.parse(request.messages[1].content);
    assert.ok(Buffer.byteLength(body) <= 14000);
    assert.equal(request.max_completion_tokens, 3000);
    assert.ok(context.evidence.some((e: Evidence) => e.origin === "attachment"));
    return Response.json({ choices: [{ message: { content: calls === 1 ? "{}" : JSON.stringify(output) } }] });
  });
  assert.equal(calls, 2);
  assert.ok(index.evidence.some(e => e.text.length > 1400), "retrieval must not mutate stored evidence");
});

test("GitHub rate limits, access denial and credentials remain distinct and preserve reset times", async () => {
  const now = 1800000000000;
  const limited = await githubFailure(Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((now + 90000) / 1000) } }), false, now);
  assert.equal(limited.code, "GITHUB_RATE_LIMIT"); assert.equal(limited.nextRetryAt, now + 91000);
  assert.match(limited.message, /Connect a GitHub token/);
  const publicFailure = providerFailure(limited, { source: "byok", allUnavailable: false, keys: [] });
  assert.equal(publicFailure.status, 429); assert.equal(publicFailure.failure.nextRetryAt, now + 91000); assert.equal(publicFailure.failure.quota, undefined);
  const denied = await githubFailure(Response.json({ message: "Resource not accessible by personal access token: PRIVATE" }, { status: 403, headers: { "x-ratelimit-remaining": "4000" } }), true, now);
  assert.equal(denied.code, "GITHUB_ACCESS_DENIED"); assert.equal(denied.nextRetryAt, undefined); assert.doesNotMatch(denied.message, /PRIVATE/);
  const secondary = await githubFailure(Response.json({ message: "secondary rate limit" }, { status: 403, headers: { "retry-after": "120" } }), true, now);
  assert.equal(secondary.nextRetryAt, now + 121000);
  const unauthenticated = await githubFailure(new Response(null, { status: 401 }), true, now);
  assert.equal(unauthenticated.code, "GITHUB_AUTH");
});
