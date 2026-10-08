import assert from "node:assert/strict";
import { test } from "node:test";
import { investigateRepository, researchCandidates, isResearchReadablePath } from "./repository-research";
import { questionTerms, questionFileAnchors, searchRepositoryEvidence } from "./evidence-search";
import { analyzeSource } from "./source-analysis";
import { archiveResponse, zipFixture } from "./test-zip-fixture";
import type { Evidence, RepositoryIndex, RepositoryTreeEntry } from "./types";

const commit = "b".repeat(40);
const originalEvidence: Evidence = { id: "old_readme_citation", path: "README.md", kind: "documentation", startLine: 1, endLine: 1, text: "Project setup guide." };
const treeFile = (path: string, bytes = 180, kind: RepositoryTreeEntry["kind"] = "source"): RepositoryTreeEntry => ({ path, bytes, kind });
function fixture(tree: RepositoryTreeEntry[] = []): RepositoryIndex {
  return { version: 1, analysisVersion: 2, id: "053f2faa-6326-4736-87f2-260f80c0a5cd", ownerKey: "owner-browser", repository: { owner: "team", name: "example", url: "https://github.com/team/example", commit }, createdAt: "2026-10-01T00:00:00.000Z", discoveredFiles: tree.length + 1, files: [{ path: "README.md", bytes: 20, kind: "documentation" }], evidence: [{ ...originalEvidence }], warnings: [], tree, sourceFiles: [] };
}
const sourceResponse = () => new Response("export function authenticateUser(request) {\n  return verifySession(request);\n}\n");

test("implementation outranks example and test copies unless the question asks about tests", () => {
  const index = fixture();
  const text = "function sample() { return generate(tokens); }";
  index.evidence = ["tests/sampling_test.py", "examples/sampling.py", "src/sampling.py"].map((path, i) => ({ id: "e" + i, path, kind: "source", startLine: 1, endLine: 1, text }));
  assert.equal(searchRepositoryEvidence(index, "How does sampling generate tokens?", 1)[0].path, "src/sampling.py");
  assert.equal(searchRepositoryEvidence(index, "Explain the sampling tests", 1)[0].path, "tests/sampling_test.py");
});

test("targeted research fetches pinned public source with no credentials or redirect following", async () => {
  const index = fixture([treeFile("src/authentication.ts"), treeFile("src/colors.ts")]);
  const before = structuredClone(index);
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  const result = await investigateRepository(index, "How does authentication work?", { fetcher: async (input, options) => {
    requests.push({ url: String(input), options }); return sourceResponse();
  } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://raw.githubusercontent.com/team/example/${commit}/src/authentication.ts`);
  assert.equal(requests[0].options?.credentials, "omit");
  assert.equal(requests[0].options?.redirect, "error");
  const headers = new Headers(requests[0].options?.headers);
  assert.equal(headers.has("authorization"), false);
  assert.equal(headers.has("cookie"), false);
  assert.deepEqual(result.research?.paths, ["src/authentication.ts"]);
  assert.equal(result.research?.fetchedFiles, 1);
  assert.deepEqual(index, before);
});

test("sensitive, vendor, generated, binary, oversized and unrelated paths are never fetched", async () => {
  const excluded = ["vendor/auth.ts", "node_modules/auth/index.js", ".env.auth.ts", "secrets/auth.py", "src/auth.generated.ts", "src/auth.d.ts", "src/auth.min.js", "assets/auth.png", "build/auth.js", "src/credentials.ts", "../auth.ts", "https://internal.example/auth.ts", "C:\\private\\auth.ts", "/auth.ts"];
  const index = fixture([treeFile("src/auth.ts"), treeFile("src/colors.ts"), treeFile("src/auth-large.ts", 512001), ...excluded.map(name => treeFile(name))]);
  const paths: string[] = [];
  await investigateRepository(index, "Explain authentication", { fetcher: async input => { paths.push(String(input)); return sourceResponse(); } });
  assert.deepEqual(paths, [`https://raw.githubusercontent.com/team/example/${commit}/src/auth.ts`]);
});

test("malicious question URLs and invalid repository coordinates cannot turn lookup into SSRF", async () => {
  const index = fixture([treeFile("src/auth.ts"), treeFile("src/%2e%2e/auth.ts")]);
  const urls: string[] = [];
  await investigateRepository(index, "Read http://169.254.169.254/latest/meta-data/auth.ts and https://evil.example/auth.ts", { fetcher: async input => { urls.push(String(input)); return sourceResponse(); } });
  assert.ok(urls.length > 0);
  for (const value of urls) {
    const url = new URL(value);
    assert.equal(url.origin, "https://raw.githubusercontent.com");
    assert.ok(url.pathname.startsWith(`/team/example/${commit}/src/`));
  }
  assert.ok(urls.some(value => value.includes("%252e%252e")), "Literal percent-encoded path segments stay encoded as repository filenames");
  for (const repository of [
    { ...index.repository, owner: "https://evil.example" },
    { ...index.repository, name: "../private" },
    { ...index.repository, commit: "main/../../private" },
  ]) {
    let calls = 0;
    const result = await investigateRepository({ ...index, repository }, "Explain auth.ts", { fetcher: async () => { calls++; return sourceResponse(); } });
    assert.equal(calls, 0);
    assert.deepEqual(result.evidence, index.evidence);
  }
});

test("research fetches at most six files including local import neighbors", async () => {
  const index = fixture([...Array.from({ length: 10 }, (_, i) => treeFile(`src/auth${i}.ts`)), treeFile("src/helper1.ts"), treeFile("src/helper2.ts")]);
  index.files.push({ path: "src/auth0.ts", kind: "source", bytes: 150 });
  index.sourceFiles = [{ path: "src/auth0.ts", language: "typescript", parser: "typescript-ast", imports: ["./helper1", "./helper2"], symbols: ["authenticateUser", "session", "login"] }];
  let calls = 0;
  const result = await investigateRepository(index, "Explain authentication and login", { maxFiles: 6, fetcher: async input => {
    calls++;
    return String(input).endsWith("/auth0.ts") ? new Response("import './helper1';\nimport './helper2';\nexport function authenticateUser() { return true; }") : sourceResponse();
  } });
  assert.equal(calls, 6);
  assert.equal(result.research?.fetchedFiles, 6);
  assert.ok(result.research?.paths.includes("src/helper1.ts"));
  assert.ok(result.research?.paths.includes("src/helper2.ts"));
});

test("the source byte limit accepts 512000 bytes and rejects both declared and streamed overflow", async () => {
  const source = "export function auth() { return true; }\n";
  const accepted = await investigateRepository(fixture([treeFile("src/auth.ts", 512000)]), "auth.ts", { fetcher: async () => new Response(source.padEnd(512000, " "), { headers: { "content-length": "512000" } }) });
  assert.equal(accepted.research?.fetchedFiles, 1);
  for (const declared of [false, true]) {
    let cancelled = false;
    const index = fixture([treeFile("src/auth.ts")]);
    const result = await investigateRepository(index, "auth.ts", { fetcher: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(512001)); }, cancel() { cancelled = true; },
    }), { headers: declared ? { "content-length": "512001" } : {} }) });
    assert.equal(cancelled, true);
    assert.equal(result.research?.fetchedFiles, 0);
    assert.deepEqual(result.evidence, index.evidence);
    assert.match(result.research?.notes.join(" ") ?? "", /text limit/);
  }
});

test("binary and malformed UTF-8 responses never become evidence", async () => {
  for (const bytes of [new Uint8Array([65, 0, 66]), new Uint8Array([0xff, 0xff])]) {
    const index = fixture([treeFile("src/auth.ts")]);
    const result = await investigateRepository(index, "auth.ts", { fetcher: async () => new Response(bytes) });
    assert.deepEqual(result.evidence, index.evidence);
    assert.equal(result.research?.fetchedFiles, 0);
    assert.ok(result.research?.notes.length);
  }
});

test("source snippets redact credentials and retain serializable parser, symbol and line metadata", async () => {
  const secret = "gsk_" + "A".repeat(40);
  const source = `import { verifySession } from './session';\nconst apiKey = '${secret}';\nexport function authenticateUser(request) {\n  return verifySession(request);\n}\n`;
  const index = fixture([treeFile("src/auth.ts", Buffer.byteLength(source))]);
  const result = await investigateRepository(index, "Explain authenticateUser in auth.ts", { fetcher: async () => new Response(source) });
  const saved: RepositoryIndex = JSON.parse(JSON.stringify(result));
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(secret));
  const snippets = saved.evidence.filter(e => e.path === "src/auth.ts");
  assert.ok(snippets.length);
  assert.ok(snippets.every(e => e.kind === "source" && e.startLine >= 1 && e.endLine >= e.startLine && /^r[a-f0-9]{24}$/.test(e.id)));
  assert.ok(snippets.some(e => e.text.includes("authenticateUser") && e.text.includes("verifySession")));
  const metadata = saved.sourceFiles?.find(file => file.path === "src/auth.ts");
  assert.equal(metadata?.parser, "typescript-ast");
  assert.ok(metadata?.symbols.includes("authenticateUser"));
  assert.ok(metadata?.imports.includes("./session"));
  assert.equal(saved.ownerKey, index.ownerKey);
  assert.equal(saved.evidence.find(e => e.id === originalEvidence.id)?.text, originalEvidence.text);
});

test("a specific implementation answer ranks ahead of README and generic documentation", () => {
  const index = fixture();
  index.evidence = [
    { ...originalEvidence, text: "Welcome to the project. See setup instructions." },
    { ...originalEvidence, id: "generic_docs", path: "docs/ARCHITECTURE.md", text: "The backend has endpoints and uses a database." },
    { id: "auth_answer", path: "src/auth/session.ts", kind: "source", startLine: 30, endLine: 42, text: "export function refreshSession(request) { return renewSession(request.cookie); }" },
  ];
  assert.ok(questionTerms("How does login work?").includes("authentication"));
  const result = searchRepositoryEvidence(index, "How does refreshSession renew a login?", 2);
  assert.equal(result[0].id, "auth_answer");
  assert.equal(result.length, 2);
});

test("local relative and alias imports resolve to indexed tree files without importing code", () => {
  const index = fixture([treeFile("src/auth.ts"), treeFile("src/helpers/index.ts"), treeFile("src/lib/tokens.ts"), treeFile("src/unrelated.ts")]);
  index.files.push({ path: "src/auth.ts", kind: "source", bytes: 120 });
  index.sourceFiles = [{ path: "src/auth.ts", language: "typescript", parser: "typescript-ast", imports: ["./helpers", "@/lib/tokens", "https://evil.example/run.ts"], symbols: ["authenticateUser"] }];
  assert.deepEqual(researchCandidates(index, "Explain authentication").map(file => file.path), ["src/auth.ts", "src/helpers/index.ts", "src/lib/tokens.ts"]);
});

test("Python relative imports stay with their own package instead of unrelated same-named modules", () => {
  const index = fixture([treeFile("app/auth.py"), treeFile("app/storage.py"), treeFile("unrelated/storage.py")]);
  index.files.push({ path: "app/auth.py", kind: "source", bytes: 120 });
  index.sourceFiles = [{ path: "app/auth.py", language: "python", parser: "python-cst", imports: [".storage"], symbols: ["authenticate_user"] }];
  assert.deepEqual(researchCandidates(index, "Explain authentication").map(file => file.path), ["app/auth.py", "app/storage.py"]);
});

test("TypeScript ESM imports ending in js resolve to the local TypeScript implementation", () => {
  const index = fixture([treeFile("src/controller.ts"), treeFile("src/worker.ts"), treeFile("unrelated/worker.ts")]);
  index.files.push({ path: "src/controller.ts", kind: "source", bytes: 180 });
  index.sourceFiles = [{ path: "src/controller.ts", language: "typescript", parser: "typescript-ast", imports: ["./worker.js"], symbols: ["handleRequest"] }];
  assert.deepEqual(researchCandidates(index, "Explain handleRequest.").map(file => file.path), ["src/controller.ts", "src/worker.ts"]);
});

test("a fresh import skips redundant indexed reads but still researches an omitted relevant neighbor", async () => {
  const index = fixture([treeFile("src/auth.ts"), treeFile("src/session.ts")]);
  index.files.push({ path: "src/auth.ts", kind: "source", bytes: 180 });
  index.evidence.push({ id: "existing_auth", path: "src/auth.ts", kind: "source", startLine: 1, endLine: 1, text: "export function authenticateUser(request) { return verifySession(request); }" });
  index.sourceFiles = [{ path: "src/auth.ts", language: "typescript", parser: "typescript-ast", imports: ["./session"], symbols: ["authenticateUser"] }];
  const calls: string[] = [];
  const result = await investigateRepository(index, "Explain authentication", { freshlyIndexed: true, fetcher: async input => {
    calls.push(String(input));
    return new Response("export function verifySession(request) { return request.cookie; }");
  } });
  assert.deepEqual(calls, [`https://raw.githubusercontent.com/team/example/${commit}/src/session.ts`]);
  assert.deepEqual(result.research?.paths, ["src/session.ts"]);
});

test("asking about a known function refreshes its file and retrieves a late implementation omitted from overview excerpts", async () => {
  const prefix = Array.from({ length: 30 }, (_, i) => `export function ordinaryHandler${i}() { return ${i}; }\n// ${"Setup context. ".repeat(70)}\n`).join("");
  const source = prefix + "export function resolvePaymentRetry(attempt) {\n  if (attempt >= 3) return 'stop';\n  return 'queue';\n}\n";
  const initial = analyzeSource("src/processing.ts", source);
  assert.ok(initial.symbols.includes("resolvePaymentRetry"));
  assert.ok(!initial.evidence.some(e => e.text.includes("resolvePaymentRetry")), "The initial bounded overview does not already contain the answer");
  const index = fixture([treeFile("src/processing.ts", Buffer.byteLength(source))]);
  index.files.push({ path: "src/processing.ts", kind: "source", bytes: Buffer.byteLength(source) });
  index.sourceFiles = [{ path: "src/processing.ts", language: initial.language, parser: initial.parser, imports: initial.imports, symbols: initial.symbols }];
  index.evidence.push(...initial.evidence.map((e, i) => ({ ...e, id: "old_source_" + i })));
  const before = structuredClone(index);
  let calls = 0;
  const question = "How does resolvePaymentRetry decide whether to retry?";
  const result = await investigateRepository(index, question, { fetcher: async input => {
    calls++;
    assert.equal(String(input), `https://raw.githubusercontent.com/team/example/${commit}/src/processing.ts`);
    return new Response(source);
  } });
  assert.equal(calls, 1);
  const focused = result.evidence.find(e => e.text.includes("resolvePaymentRetry") && e.text.includes("return 'stop'"));
  assert.ok(focused);
  assert.match(focused.text, /attempt >= 3/);
  assert.match(focused.text, /return 'stop'/);
  assert.match(focused.text, /return 'queue'/);
  const functionLine = prefix.split("\n").length;
  assert.ok(focused.startLine >= functionLine - 2 && focused.endLine >= functionLine + 2);
  assert.match(searchRepositoryEvidence(result, question, 1)[0].text, /resolvePaymentRetry/);
  for (const old of before.evidence) assert.deepEqual(result.evidence.find(e => e.id === old.id), old);
  assert.deepEqual(index, before);
});

test("an unavailable lookup preserves saved evidence and records a coverage limit", async () => {
  for (const failure of ["http", "network"]) {
    const index = fixture([treeFile("src/auth.ts")]);
    const before = structuredClone(index);
    const result = await investigateRepository(index, "auth.ts", { fetcher: async () => {
      if (failure === "network") throw new TypeError("network unavailable");
      return new Response(null, { status: 404 });
    } });
    assert.deepEqual(result.evidence, index.evidence);
    assert.deepEqual(result.files, index.files);
    assert.equal(result.research?.fetchedFiles, 0);
    assert.ok(result.research?.notes.length);
    assert.deepEqual(index, before);
  }
});

test("caller cancellation during a source read stops research and preserves existing evidence", async () => {
  const index = fixture([treeFile("src/auth.ts")]);
  const before = structuredClone(index);
  const controller = new AbortController();
  let cancelled = false;
  await assert.rejects(investigateRepository(index, "auth.ts", { signal: controller.signal, fetcher: async () => new Response(new ReadableStream({
    pull() { controller.abort(); }, cancel() { cancelled = true; },
  }, { highWaterMark: 0 })) }), { name: "AbortError" });
  assert.equal(cancelled, true);
  assert.deepEqual(index, before);
});

test("older blueprint indexes upgrade from the pinned ZIP without changing owner, identity, citations or attachments", async () => {
  const index = fixture();
  delete index.tree;
  delete index.sourceFiles;
  index.instructions = "Explain onboarding to a new backend engineer.";
  index.evidence.push({ ...originalEvidence, id: "uploaded_context", path: "uploads/team-guide.md", origin: "attachment", text: "Our team owns this component." });
  index.warnings.push("Earlier blueprint-only coverage.");
  const original = structuredClone(index);
  const zip = zipFixture([{ name: "snapshot/README.md", text: originalEvidence.text }, { name: "snapshot/src/auth.ts", text: "export function authenticateUser(request) { return verifySession(request); }" }], commit);
  const requests: string[] = [];
  const result = await investigateRepository(index, "Explain authentication", { fetcher: async (input, options) => {
    const url = String(input); requests.push(url);
    assert.equal(url, `https://codeload.github.com/team/example/zip/${commit}`);
    assert.equal(options?.redirect, "error");
    assert.equal(new Headers(options?.headers).has("authorization"), false);
    return archiveResponse(zip);
  } });
  assert.equal(requests.length, 1);
  assert.equal(result.id, index.id);
  assert.equal(result.ownerKey, index.ownerKey);
  assert.deepEqual(result.repository, index.repository);
  assert.equal(result.createdAt, index.createdAt);
  assert.equal(result.instructions, index.instructions);
  assert.deepEqual(result.evidence.find(e => e.id === originalEvidence.id), originalEvidence);
  assert.deepEqual(result.evidence.find(e => e.id === "uploaded_context"), index.evidence[1]);
  assert.ok(result.tree?.some(file => file.path === "src/auth.ts"));
  assert.ok(result.sourceFiles?.some(file => file.path === "src/auth.ts"));
  assert.ok(result.evidence.some(e => e.kind === "source" && e.path === "src/auth.ts"));
  assert.equal(new Set(result.evidence.map(e => e.id)).size, result.evidence.length);
  assert.ok(result.warnings.includes(index.warnings[0]));
  assert.deepEqual(index, original);
});

test("an unavailable old-index upgrade honestly falls back to saved evidence", async () => {
  const index = fixture();
  delete index.tree;
  let calls = 0;
  const result = await investigateRepository(index, "How does authentication work?", { fetcher: async () => { calls++; return new Response(null, { status: 404 }); } });
  assert.equal(calls, 1);
  assert.deepEqual(result.evidence, index.evidence);
  assert.match(result.research?.notes.join(" ") ?? "", /file map was unavailable/);
  assert.equal(result.research?.fetchedFiles, 0);
});

test("exact file and line anchors win over same-named files and early overview snippets", async () => {
  const source = Array.from({ length: 450 }, (_, i) => i === 420 ? "export const specialThreshold = 42;" : `// ordinary line ${i + 1}`).join("\n");
  const index = fixture([treeFile("src/settings.ts", Buffer.byteLength(source)), treeFile("other/settings.ts")]);
  const question = "Explain src/settings.ts#L421-L425";
  assert.deepEqual(questionFileAnchors(index, question), [{ path: "src/settings.ts", startLine: 421, endLine: 425 }]);
  assert.deepEqual(questionFileAnchors(index, "Explain lines 421–425 of src\\settings.ts"), [{ path: "src/settings.ts", startLine: 421, endLine: 425 }]);
  assert.deepEqual(researchCandidates(index, question).map(file => file.path), ["src/settings.ts"]);
  const result = await investigateRepository(index, question, { fetcher: async input => {
    assert.ok(String(input).endsWith("/src/settings.ts")); return new Response(source);
  } });
  const answer = searchRepositoryEvidence(result, question, 1)[0];
  assert.equal(answer.path, "src/settings.ts");
  assert.ok(answer.startLine <= 421 && answer.endLine >= 421);
  assert.match(answer.text, /specialThreshold = 42/);
  assert.deepEqual(questionFileAnchors(index, "src/settings.ts:999999999999999999999"), [{ path: "src/settings.ts" }]);
});

test("research follows imported modules and reverse importers within the requested hop bound", () => {
  const index = fixture(["src/core.ts", "src/helper.ts", "src/routes.ts", "src/cli.ts", "src/unrelated.ts"].map(file => treeFile(file)));
  index.sourceFiles = [
    { path: "src/core.ts", imports: ["./helper"], symbols: ["processItem"] },
    { path: "src/routes.ts", imports: ["./core"], symbols: ["handle"] },
    { path: "src/cli.ts", imports: ["./routes"], symbols: ["run"] },
  ].map(file => ({ ...file, language: "typescript", parser: "typescript-ast" }));
  assert.deepEqual(researchCandidates(index, "What would changing src/core.ts affect?", true, { maxHops: 1 }).map(file => file.path), ["src/core.ts", "src/helper.ts", "src/routes.ts"]);
  assert.deepEqual(researchCandidates(index, "What would changing src/core.ts affect?", true, { maxHops: 2 }).map(file => file.path), ["src/core.ts", "src/helper.ts", "src/routes.ts", "src/cli.ts"]);
});

test("newly inspected imports expand research iteratively without exceeding two hops", async () => {
  const sources: Record<string, string> = {
    "entry.ts": "import './middle'; export const entry = 1;",
    "middle.ts": "import './leaf'; export const middle = 1;",
    "leaf.ts": "import './beyond'; export const leaf = 1;",
    "beyond.ts": "export const beyond = 1;",
  };
  const index = fixture(Object.keys(sources).map(file => treeFile("src/" + file)));
  const result = await investigateRepository(index, "Explain src/entry.ts", { fetcher: async input => new Response(sources[String(input).split("/").at(-1)!]) });
  assert.deepEqual(result.research?.paths, ["src/entry.ts", "src/middle.ts", "src/leaf.ts"]);
});

test("metadata-only files are read on the initial import when a named definition needs its body", async () => {
  const index = fixture([treeFile("src/polynomials.ts")]);
  index.files.push({ path: "src/polynomials.ts", kind: "source", bytes: 180 });
  index.sourceFiles = [{ path: "src/polynomials.ts", language: "typescript", parser: "typescript-ast", imports: [], symbols: [], definitions: [{ name: "evaluateLegendre", kind: "function", startLine: 1, endLine: 3 }] }];
  const result = await investigateRepository(index, "How does evaluateLegendre work?", { freshlyIndexed: true, fetcher: async () => new Response("export function evaluateLegendre(x) {\n return (3 * x * x - 1) / 2;\n}") });
  assert.deepEqual(result.research?.paths, ["src/polynomials.ts"]);
  assert.match(searchRepositoryEvidence(result, "evaluateLegendre", 1)[0].text, /3 \* x \* x/);
});

test("caller file and byte budgets bound iterative research and disclose incomplete coverage", async () => {
  const sources = { "entry.ts": "import './middle'; export const entry = 1;", "middle.ts": "import './leaf'; export const middle = 1;", "leaf.ts": "export const leaf = 1;" };
  const index = fixture(Object.entries(sources).map(([name, text]) => treeFile("src/" + name, Buffer.byteLength(text))));
  const fetcher: typeof fetch = async input => new Response(sources[String(input).split("/").at(-1)! as keyof typeof sources]);
  const byFiles = await investigateRepository(index, "src/entry.ts", { maxFiles: 2, fetcher });
  assert.deepEqual(byFiles.research?.paths, ["src/entry.ts", "src/middle.ts"]);
  assert.match(byFiles.research?.notes.join(" ") ?? "", /2-file budget/);
  const byBytes = await investigateRepository(index, "src/entry.ts", { maxBytes: Buffer.byteLength(sources["entry.ts"]) + 1, fetcher });
  assert.deepEqual(byBytes.research?.paths, ["src/entry.ts"]);
  assert.match(byBytes.research?.notes.join(" ") ?? "", /byte budget/);
});

test("explicit safe configuration and CI text remain quoted evidence with redacted secrets and exact lines", async () => {
  for (const file of [".github/workflows/check.yml", "docs/dev-guide.rst", "config/settings.toml", "settings.ini", "project.xml"]) {
    assert.equal(isResearchReadablePath(file), true);
    const text = Array.from({ length: 50 }, (_, i) => i === 30 ? "test_command = npm test" : i === 31 ? 'api_key = "gsk_' + "A".repeat(40) + '"' : "# ordinary setup line").join("\n");
    const index = fixture([treeFile(file, Buffer.byteLength(text), "blueprint")]);
    const result = await investigateRepository(index, `${file}:31-32`, { fetcher: async () => new Response(text) });
    const answer = searchRepositoryEvidence(result, `${file}:31-32`, 1)[0];
    assert.equal(answer.kind, "documentation");
    assert.equal(answer.path, file);
    assert.equal(answer.startLine, 31);
    assert.match(answer.text, /npm test/);
    assert.doesNotMatch(JSON.stringify(result), /gsk_A{40}/);
  }
  for (const file of ["package-lock.json", "Cargo.lock", "node_modules/a.txt", "secrets/setup.md"]) assert.equal(isResearchReadablePath(file), false);
});

test("onboarding research pairs contributor docs with public and central implementation across packages", () => {
  const paths = ["README.md", "CONTRIBUTING.md", "docs/development/index.rst", ".github/ISSUE_TEMPLATE/bug_report.md", ".github/workflows/tutorial.yml", "library/__init__.py", "library/data/core.py", "library/data/read.py", "library/analysis/core.py", "library/analysis/run.py", "tests/test_core.py", "examples/contribute.py"];
  const index = fixture(paths.map(file => treeFile(file)));
  index.sourceFiles = [
    { path: "library/__init__.py", imports: [".analysis.core", ".data.core"], symbols: [] },
    { path: "library/analysis/run.py", imports: [".core", "..data.core"], symbols: [] },
    { path: "library/data/read.py", imports: [".core"], symbols: [] },
  ].map(file => ({ ...file, language: "python", parser: "python-cst" }));
  const question = "I'm a beginner, want to contribute to this repo, help me figure out codebase";
  index.sourceFiles[0].definitions = ["repo", "help", "figure", "contribute"].map(name => ({ name, kind: "variable", startLine: 1, endLine: 1 }));
  const candidates = researchCandidates(index, question, true, { maxFiles: 6 }).map(file => file.path);
  assert.ok(candidates.includes("CONTRIBUTING.md"));
  assert.ok(candidates.includes("library/__init__.py"));
  assert.ok(candidates.includes("library/data/core.py"));
  assert.ok(candidates.includes("library/analysis/core.py"));
  assert.ok(!candidates.some(file => /ISSUE_TEMPLATE|workflows|tests\/|examples\//.test(file)));
  index.evidence = [
    ...Array.from({ length: 8 }, (_, i) => ({ ...originalEvidence, id: "guide" + i, path: "CONTRIBUTING.md", startLine: 1 + i * 10, endLine: 10 + i * 10, text: "Beginner contributor development guide codebase" })),
    { id: "implementation", path: "library/__init__.py", kind: "source", startLine: 1, endLine: 3, text: "from .analysis.core import Analysis\nfrom .data.core import Dataset" },
    { id: "core", path: "library/data/core.py", kind: "source", startLine: 1, endLine: 3, text: "class Dataset:\n    def read(self): return read_table(self.path)" },
  ];
  const answer = searchRepositoryEvidence(index, question, 4);
  assert.equal(answer[0].kind, "documentation");
  assert.equal(answer[1].kind, "source");
  assert.equal(answer.filter(source => source.path === "CONTRIBUTING.md").length, 2);
});

test("a pre-definition-map index upgrades once even when it already has a tree", async () => {
  const index = fixture([treeFile("src/main.ts")]);
  index.analysisVersion = 1;
  const archive = zipFixture([{ name: "snapshot/README.md", text: originalEvidence.text }, { name: "snapshot/src/main.ts", text: "export function main() { return 1; }" }], commit);
  let archiveCalls = 0;
  const fetcher: typeof fetch = async input => {
    if (String(input).startsWith("https://codeload.github.com/")) { archiveCalls++; return archiveResponse(archive); }
    return new Response("export function main() { return 1; }");
  };
  const upgraded = await investigateRepository(index, "Explain main", { fetcher });
  assert.equal(upgraded.analysisVersion, 2);
  assert.equal(upgraded.id, index.id);
  assert.deepEqual(upgraded.evidence.find(source => source.id === originalEvidence.id), originalEvidence);
  await investigateRepository(upgraded, "Explain main", { fetcher });
  assert.equal(archiveCalls, 1);
});

test("onboarding keeps a worker method ahead of same-directory export barrels and test importers", async () => {
  const index = fixture([treeFile("README.md", 20, "blueprint"), treeFile("src/index.ts"), treeFile("src/worker.ts"), ...Array.from({ length: 20 }, (_, i) => treeFile(`tests/worker${i}.ts`))]);
  const barrel: Evidence = { id: "barrel", path: "src/index.ts", kind: "source", startLine: 1, endLine: 1, text: "export { Worker } from './worker';" };
  const body: Evidence = { id: "body", path: "src/worker.ts", kind: "source", startLine: 1, endLine: 5, text: "export class Worker {\n  run(job) {\n    return execute(job);\n  }\n}" };
  index.evidence.push(barrel, body);
  index.sourceFiles = [
    { path: "src/index.ts", imports: ["./worker"], symbols: ["Worker"], definitions: [] },
    { path: "src/worker.ts", imports: [], symbols: ["Worker", "run"], definitions: [{ name: "Worker", kind: "class", startLine: 1, endLine: 5 }, { name: "run", kind: "method", startLine: 2, endLine: 4 }] },
    ...Array.from({ length: 20 }, (_, i) => ({ path: `tests/worker${i}.ts`, imports: ["../src/worker"], symbols: [], definitions: [] })),
  ].map(file => ({ ...file, language: "typescript", parser: "typescript-ast" })) as NonNullable<RepositoryIndex["sourceFiles"]>;
  const question = "I'm a beginner and want to contribute to this codebase";
  const paths = researchCandidates(index, question).map(file => file.path);
  assert.ok(paths.includes("src/worker.ts"));
  assert.ok(paths.includes("src/index.ts"));
  assert.ok(!paths.some(file => file.startsWith("tests/")));
  assert.equal(searchRepositoryEvidence(index, question, 2)[1].id, "body");
  let calls = 0;
  await investigateRepository(index, question, { freshlyIndexed: true, fetcher: async () => { calls++; return sourceResponse(); } });
  assert.equal(calls, 0, "Fresh useful evidence does not trigger test-importer filler reads");
  assert.ok(researchCandidates(index, "Explain tests/worker0.ts").some(file => file.path === "tests/worker0.ts"));
});

test("static local imports resolve C headers, Java packages, Go packages and Rust crate modules", () => {
  for (const fixtureCase of [
    { file: "src/main.cpp", dependency: "src/worker.h", language: "cpp", parser: "cpp-cst", imported: "worker.h" },
    { file: "src/main/java/app/Main.java", dependency: "src/main/java/app/Worker.java", language: "java", parser: "java-cst", imported: "app.Worker" },
    { file: "cmd/main.go", dependency: "internal/worker/task.go", language: "go", parser: "go-cst", imported: "github.com/team/example/internal/worker" },
    { file: "src/lib.rs", dependency: "src/worker.rs", language: "rust", parser: "rust-cst", imported: "worker::run" },
    { file: "src/jobs/queue.rs", dependency: "src/worker.rs", language: "rust", parser: "rust-cst", imported: "crate::worker::run" },
  ] as const) {
    const index = fixture([treeFile(fixtureCase.file), treeFile(fixtureCase.dependency)]);
    index.sourceFiles = [{ path: fixtureCase.file, language: fixtureCase.language, parser: fixtureCase.parser, symbols: [], imports: [fixtureCase.imported] }];
    assert.deepEqual(researchCandidates(index, `Explain ${fixtureCase.file}`).map(file => file.path), [fixtureCase.file, fixtureCase.dependency]);
  }
});
