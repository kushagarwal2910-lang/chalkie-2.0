import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSource, classifySource, isSafeRepositoryPath } from "./source-analysis.ts";

test("source allowlist recognizes implementation languages and rejects non-source assets", () => {
  for (const [path, language] of [["src/auth.py", "python"], ["app/api/route.ts", "typescript"], ["src/App.jsx", "javascript"], ["src/lib.rs", "rust"], ["cmd/main.go", "go"], ["src/service.java", "java"], ["ui/Page.svelte", "svelte"]]) assert.equal(classifySource(path), language);
  for (const path of ["README.md", "package.json", "model.safetensors", "assets/logo.svg", "archive.zip", "photo.png"]) assert.equal(classifySource(path), null);
  assert.ok(isSafeRepositoryPath("docs/design.md"), "safe documentation paths use the shared path policy");
});

test("secret, vendor, generated and unsafe paths cannot be read as source", () => {
  for (const path of [".env", ".env.local", "src/.env.production.py", "src/secrets.py", "config/prod.credentials.ts", "keys/private-key.py", "certs/client.key", "infra/main.tfstate", ".aws/config", "node_modules/pkg/index.js", "vendor/lib.py", "third_party/tool.cc", "__pycache__/app.py", "dist/index.js", "src/__generated__/types.ts", "src/client.generated.ts", "src/types.d.ts", "src/bundle.min.js", "src/message_pb2.py", "src/thing.pb.go", "../app.ts", "/app.ts", "src//app.ts", "src\\app.ts", "C:/app.ts", "src/\u0000app.ts"] ) {
    assert.equal(isSafeRepositoryPath(path), false, path); assert.equal(classifySource(path), null, path);
  }
});

test("TypeScript AST preserves imports, declared functions, route calls and returns as exact source", () => {
  const text = [
    'import { Router } from "express";',
    'import { submit } from "./jobs";',
    'const app = Router();',
    'app.post("/jobs", async (req, res) => {',
    '  const id = await submit(req.body);',
    '  return res.json({ id });',
    '});',
    'export async function status(id: string) {',
    '  return fetch(`/jobs/${id}`);',
    '}',
  ].join("\n");
  const result = analyzeSource("src/api.ts", text);
  assert.equal(result.parser, "typescript-ast"); assert.equal(result.language, "typescript");
  assert.deepEqual(result.imports, ["express", "./jobs"]);
  for (const name of ["Router", "app.post", "submit", "res.json", "status", "fetch"]) assert.ok(result.symbols.includes(name), name);
  assert.ok(result.evidence.some(item => item.text.includes('app.post("/jobs"') && item.text.includes("return res.json")));
  for (const item of result.evidence) {
    assert.equal(item.kind, "source"); assert.equal(item.path, "src/api.ts");
    assert.ok(text.split("\n").slice(item.startLine - 1, item.endLine).join("\n").includes(item.text));
    assert.ok(item.startLine >= 1 && item.endLine <= 10);
  }
});

test("JavaScript, JSX, TSX, CommonJS and dynamic imports use syntax parsing without following modules", () => {
  const js = analyzeSource("server.cjs", 'const client = require("./client");\nasync function run() { const task = await import("./task.js"); return task.start(client); }');
  assert.deepEqual(js.imports, ["./client", "./task.js"]); assert.equal(js.parser, "typescript-ast");
  for (const path of ["App.jsx", "App.tsx"]) {
    const result = analyzeSource(path, 'import React from "react";\nexport function App() { return <button onClick={() => send()}>Send</button>; }');
    assert.equal(result.parser, "typescript-ast"); assert.ok(result.symbols.includes("App")); assert.ok(result.symbols.includes("send"));
  }
});

test("commented imports and call-shaped strings do not become AST import or symbol metadata", () => {
  const result = analyzeSource("src/index.js", '// require("fake-package"); pretendCall();\nconst help = "fakeFunction()";\nexport function real() { return actual(); }');
  assert.deepEqual(result.imports, []); assert.ok(result.symbols.includes("actual"));
  assert.ok(!result.symbols.includes("pretendCall")); assert.ok(!result.symbols.includes("fakeFunction"));
});

test("Python CST preserves decorated routes, imports, calls and return flow", () => {
  const text = [
    "from fastapi import FastAPI", "from .jobs import submit", "import json as codec, os", "app = FastAPI()", "",
    '@app.post("/jobs")', "async def create_job(payload):", "    result = await submit(payload)", '    return {"job": result}', "",
    "class Worker:", "    def process(self, task):", "        return execute(task)",
  ].join("\n");
  const result = analyzeSource("app/api.py", text);
  assert.equal(result.parser, "python-cst"); assert.equal(result.language, "python");
  for (const name of ["fastapi", ".jobs", ".jobs.submit", "json", "os"]) assert.ok(result.imports.includes(name), name);
  for (const name of ["create_job", "submit", "Worker", "process", "execute"]) assert.ok(result.symbols.includes(name), name);
  assert.ok(result.evidence.some(item => item.text.includes('@app.post("/jobs")') && item.text.includes("async def create_job")));
  assert.ok(result.evidence.some(item => item.text.includes('return {"job": result}')));
  for (const item of result.evidence) assert.ok(text.split("\n").slice(item.startLine - 1, item.endLine).join("\n").includes(item.text));
});

test("unsupported AST languages remain bounded source text without invented metadata", () => {
  const result = analyzeSource("src/main.rb", 'def main\n  puts "hello"\nend\n');
  assert.equal(result.parser, "text"); assert.equal(result.language, "ruby"); assert.deepEqual(result.imports, []); assert.deepEqual(result.symbols, []); assert.equal(result.analysisComplete, false);
  assert.ok(result.evidence.some(item => item.text.includes('puts "hello"')));
});

test("secret assignments and multiline credentials are masked before snippets are selected", () => {
  const secret = "gsk_" + "x".repeat(30);
  const text = ['const api_key = "never-expose-this-value";', 'const privateKey = `-----BEGIN PRIVATE KEY-----', "UNIQUE_PRIVATE_MATERIAL", "-----END PRIVATE KEY-----`;", `const value = "${secret}";`, "export function start() {", "  return connect();", "}"].join("\n");
  const result = analyzeSource("src/start.ts", text);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /never-expose|UNIQUE_PRIVATE_MATERIAL|gsk_/);
  assert.ok(result.evidence.some(item => item.text.includes("return connect()")));
  const item = result.evidence.find(item => item.text.includes("return connect()"))!;
  const line = item.startLine + item.text.slice(0, item.text.indexOf("return connect()")).split("\n").length - 1;
  assert.equal(line, 7, "redaction preserves original line counts");
});

test("a source window in the middle of a long credential never exposes its tail", () => {
  const material = "PRIVATE_MATERIAL_TO_MASK_".repeat(80);
  const text = `const api_key = "${material}";\nexport function send() { return transport(); }\n`;
  const result = analyzeSource("src/send.js", text, "send transport PRIVATE_MATERIAL_TO_MASK");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_MATERIAL_TO_MASK/);
  assert.ok(result.evidence.some(item => item.text.includes("transport()")));
});

test("multiline and prefixed credential assignments retain line positions without leaking values", () => {
  const text = ['OPENAI_API_KEY = """', "UNIQUE_MULTILINE_VALUE", '"""', 'DB_PASSWORD = "UNIQUE_DATABASE_VALUE"', 'def start():', '    return dispatch()'].join("\n");
  const result = analyzeSource("app/start.py", text);
  assert.doesNotMatch(JSON.stringify(result), /UNIQUE_MULTILINE_VALUE|UNIQUE_DATABASE_VALUE/);
  const item = result.evidence.find(item => item.text.includes("return dispatch()"))!;
  assert.ok(item);
  assert.equal(item.startLine + item.text.slice(0, item.text.indexOf("return dispatch()")).split("\n").length - 1, 6);
});

test("ML token arrays, numeric IDs, tokenizer calls and derived values survive source redaction", () => {
  const text = [
    "def sample(logits, tokenizer, prompt):", "    token_id = 101", "    num_tokens = 128", "    tokens = [101, 202]", "    input_tokens = tokenizer.encode(prompt)", "    tokens = input_tokens.at[0].set(token_id)", "    next_token = logits.argmax(axis=-1)", "    output_tokens: list[int] = tokens + [next_token]", "    return output_tokens",
  ].join("\n");
  const result = analyzeSource("model/sampling.py", text);
  const snippets = result.evidence.map(item => item.text).join("\n");
  for (const expected of ["token_id = 101", "num_tokens = 128", "tokens = [101, 202]", "input_tokens = tokenizer.encode(prompt)", "next_token = logits.argmax(axis=-1)", "output_tokens: list[int] = tokens + [next_token]"]) assert.ok(snippets.includes(expected), expected);
  assert.doesNotMatch(snippets, /\[REDACTED\]/);
});

test("ML token exemptions never expose literal authentication or access tokens", () => {
  const text = [
    'const token = "PLAIN_LITERAL_CREDENTIAL";', 'const tokens = ["TOKEN_LIST_CREDENTIAL"];', 'const apiToken = "API_LITERAL_CREDENTIAL";', 'const access_token = "ACCESS_LITERAL_CREDENTIAL";', 'const refreshToken = "REFRESH_LITERAL_CREDENTIAL";', 'const authToken = 987654;', '// token = COMMENT_CREDENTIAL', 'const tokens2 = tokenizer.encode("gsk_' + "X".repeat(30) + '");', 'const tokens = tokenizer.encode(prompt);', 'export function sample() { return tokens; }',
  ].join("\n");
  const result = analyzeSource("src/sampler.ts", text);
  const output = JSON.stringify(result);
  assert.doesNotMatch(output, /PLAIN_LITERAL|TOKEN_LIST|API_LITERAL|ACCESS_LITERAL|REFRESH_LITERAL|987654|COMMENT_CREDENTIAL|gsk_/);
  assert.ok(result.evidence.some(item => item.text.includes("tokens = tokenizer.encode(prompt)")));
});

test("assignment-like credentials in docstrings and multiline comments cannot use ML exemptions", () => {
  const cases = [
    ["src/sampler.ts", "/*\ntoken = SECRET_WORD/PRIVATE_VALUE+OTHER_VALUE\n*/\nconst tokens = tokenizer.encode(prompt);\nexport function run() { return tokens; }"],
    ["src/sampler.py", '"""\ntoken = SECRET_WORD/PRIVATE_VALUE+OTHER_VALUE\n"""\ntokens = tokenizer.encode(prompt)\ndef run():\n    return tokens'],
  ];
  for (const [path, text] of cases) {
    const result = analyzeSource(path, text);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_WORD|PRIVATE_VALUE|OTHER_VALUE/);
    assert.ok(result.evidence.some(item => item.text.includes("tokens = tokenizer.encode(prompt)")));
  }
});

test("long non-sensitive comment lines stay bounded without legacy redactor backtracking", () => {
  const text = "export function processTask(){ return 'processed'; }\n// " + "x".repeat(99940);
  const result = analyzeSource("src/task.ts", text);
  assert.equal(result.parser, "typescript-ast"); assert.ok(result.symbols.includes("processTask"));
  assert.ok(result.evidence.length > 0 && result.evidence.every(item => item.text.length <= 1800));
});

test("CRLF source line references remain accurate", () => {
  const text = '// Header\r\n\r\nexport function run() {\r\n  return submit();\r\n}\r\n';
  const result = analyzeSource("src/run.ts", text);
  const item = result.evidence.find(item => item.text.includes("return submit()"))!;
  const line = item.startLine + item.text.slice(0, item.text.indexOf("return submit()")).split("\n").length - 1;
  assert.equal(line, 4);
});

test("analysis caps snippets, metadata and UTF-8 input and ignores generated or binary payloads", () => {
  const text = Array.from({ length: 180 }, (_, i) => `import dep${i} from "dependency-${i}";\nexport function task${i}() { return invoke${i}(dep${i}); }\n${"// local explanation\n".repeat(5)}`).join("\n");
  const result = analyzeSource("src/tasks.ts", text);
  assert.ok(result.evidence.length > 0 && result.evidence.length <= 20);
  assert.ok(result.imports.length <= 1000 && result.symbols.length <= 1000 && result.definitions.length <= 1000);
  assert.ok(result.evidence.every(item => item.text.length <= 1800));
  for (const input of ["x".repeat(512001), "é".repeat(260000), "\u0000binary", "// Code generated automatically. DO NOT EDIT.\nfunction run() {}", ""]) assert.deepEqual(analyzeSource("app.js", input).evidence, []);
  assert.deepEqual(analyzeSource("secrets.py", "password = 'must-not-parse'").evidence, []);
});

test("focused follow-up analysis retrieves a late symbol before generic snippets fill the cap", () => {
  const text = Array.from({ length: 90 }, (_, i) => `export function task${i}() {\n${"  doSomething();\n".repeat(8)}  return finish();\n}\n`).join("\n") + "export function rareDispatch() {\n  return queue.publish(message);\n}\n";
  const generic = analyzeSource("src/tasks.ts", text);
  const focused = analyzeSource("src/tasks.ts", text, "How does rareDispatch publish a message?");
  assert.ok(focused.evidence.some(item => item.text.includes("function rareDispatch")));
  assert.ok(focused.evidence.length <= 20); assert.ok(generic.evidence.length <= 20);
});

test("long preceding comment lines cannot crowd a focused function body out of its source window", () => {
  const prefix = Array.from({ length: 30 }, (_, i) => `export function ordinaryHandler${i}() { return ${i}; }\n// ${"Setup context. ".repeat(70)}\n`).join("\n");
  const text = prefix + "export function resolvePaymentRetry(attempt) {\n  if (attempt >= 3) return 'stop';\n  return 'queue';\n}\n";
  const result = analyzeSource("src/retries.ts", text, "How does resolvePaymentRetry decide whether to retry?");
  assert.ok(result.evidence.some(item => item.text.includes("function resolvePaymentRetry") && item.text.includes("return 'stop'") && item.text.includes("return 'queue'")));
});

test("source inspection never executes top-level repository statements", () => {
  const key = "__chalkie_source_execution_test__";
  const before = Reflect.get(globalThis, key);
  const result = analyzeSource("src/test.js", `globalThis.${key} = "executed";\nthrow new Error("must never execute");\nexport function work() { return run(); }`);
  assert.equal(Reflect.get(globalThis, key), before); assert.equal(result.parser, "typescript-ast");
  assert.ok(result.evidence.length > 0);
});

test("TypeScript definition metadata separates named declarations from invocations", () => {
  const text = ['export interface Job { id: string }', 'export type JobId = string;', 'export class Worker {', '  run(task: Job) { return submit(task); }', '  close = () => shutdown();', '}', 'export const start = () => new Worker();'].join("\n");
  const result = analyzeSource("src/worker.ts", text);
  for (const [name, kind] of [["Job", "interface"], ["JobId", "type"], ["Worker", "class"], ["run", "method"], ["close", "method"], ["start", "function"]]) assert.ok(result.definitions.some(item => item.name === name && item.kind === kind), name);
  assert.ok(result.symbols.includes("submit")); assert.ok(!result.definitions.some(item => item.name === "submit"));
  assert.deepEqual(result.definitions.find(item => item.name === "Worker"), { name: "Worker", kind: "class", startLine: 3, endLine: 6 });
  assert.equal(result.analysisComplete, true);
});

test("Python definition metadata identifies classes and methods with original source lines", () => {
  const text = ['class Worker:', '    def run(self, task):', '        return submit(task)', '', 'def main():', '    return Worker().run(task)'].join("\n");
  const result = analyzeSource("src/worker.py", text);
  assert.deepEqual(result.definitions.find(item => item.name === "Worker"), { name: "Worker", kind: "class", startLine: 1, endLine: 3 });
  assert.ok(result.definitions.some(item => item.name === "run" && item.kind === "method"));
  assert.ok(result.definitions.some(item => item.name === "main" && item.kind === "function"));
  assert.ok(!result.definitions.some(item => item.name === "submit")); assert.equal(result.analysisComplete, true);
});

test("C and C++ use a concrete syntax parser for includes, classes and defined functions", () => {
  const text = '#include "worker.h"\nclass Worker {\n public:\n  int run(int n) { return send(n); }\n};\nint execute() { Worker w; return w.run(1); }';
  const result = analyzeSource("src/worker.cpp", text);
  assert.equal(result.parser, "cpp-cst"); assert.ok(result.imports.includes("worker.h"));
  for (const [name, kind] of [["Worker", "class"], ["run", "method"], ["execute", "function"]]) assert.ok(result.definitions.some(item => item.name === name && item.kind === kind), name);
  assert.ok(!result.definitions.some(item => item.name === "send")); assert.equal(result.analysisComplete, true);
  assert.equal(analyzeSource("src/main.c", "int main(void) { return execute(); }").parser, "cpp-cst");
  const multiline = analyzeSource("src/run.cpp", "int\nexecute()\n{\n  return send();\n}");
  assert.deepEqual(multiline.definitions.filter(item => item.name === "execute"), [{ name: "execute", kind: "function", startLine: 1, endLine: 5 }]);
});

test("Java, Go and Rust expose parsed classes/types and methods without inferring executions", () => {
  const fixtures = [
    { path: "Worker.java", parser: "java-cst", text: "import java.util.List;\npublic class Worker { public int run(int n) { return send(n); } }\ninterface Job { void start(); }", names: [["Worker", "class"], ["Job", "interface"], ["run", "method"]] },
    { path: "worker.go", parser: "go-cst", text: 'package main\nimport "fmt"\ntype Worker struct { Count int }\nfunc (w *Worker) Run(n int) int { return send(n) }\nfunc main() { fmt.Println("hi") }', names: [["Worker", "class"], ["Run", "method"], ["main", "function"]] },
    { path: "worker.rs", parser: "rust-cst", text: "use crate::jobs::submit;\nstruct Worker { count: i32 }\ntrait Job { fn start(&self); }\nimpl Worker { fn run(&self, n: i32) -> i32 { submit(n) } }\nfn main() { Worker { count: 0 }; }", names: [["Worker", "class"], ["Job", "interface"], ["run", "method"], ["main", "function"]] },
  ];
  for (const fixture of fixtures) {
    const result = analyzeSource(fixture.path, fixture.text);
    assert.equal(result.parser, fixture.parser); assert.equal(result.analysisComplete, true, fixture.path);
    assert.ok(result.imports.length > 0);
    for (const [name, kind] of fixture.names) assert.ok(result.definitions.some(item => item.name === name && item.kind === kind), fixture.path + ":" + name);
  }
});

test("explicit line requests prioritize the requested region beyond ordinary snippet limits", () => {
  const lines = Array.from({ length: 450 }, (_, i) => `const item${i} = ${i};`);
  lines[419] = "const desired = performSpecificCalculation();";
  const text = lines.join("\n");
  for (const question of ["Explain src/items.ts:420-422", "Explain src/items.ts#L420-L422", "What happens at line 420?", "Explain L420-L422 in src/items.ts"]) {
    const result = analyzeSource("src/items.ts", text, question);
    assert.ok(result.evidence[0].text.includes("performSpecificCalculation"), question);
    assert.ok(result.evidence[0].startLine <= 420 && result.evidence[0].endLine >= 422, question);
  }
  const explicit = analyzeSource("src/items.ts", text, "Explain this", [{ startLine: 420, endLine: 422 }]);
  assert.ok(explicit.evidence[0].text.includes("performSpecificCalculation"));
});

test("explicit line windows retain source redaction, bounds and unsupported-language honesty", () => {
  const text = Array.from({ length: 250 }, (_, i) => i === 219 ? 'api_key = "MUST_NOT_LEAK"' : `value_${i} = ${i}`).join("\n");
  const result = analyzeSource("config/settings.rb", text, "Inspect line 220", [{ startLine: 220, endLine: 224 }]);
  assert.equal(result.parser, "text"); assert.equal(result.analysisComplete, false); assert.doesNotMatch(JSON.stringify(result), /MUST_NOT_LEAK/);
  assert.ok(result.evidence[0].startLine <= 220 && result.evidence[0].endLine >= 224);
  assert.ok(result.evidence.length <= 20 && result.evidence.every(item => item.text.length <= 1800));
});

test("definition metadata exceeds old overview limits and reports capped or invalid analysis honestly", () => {
  const complete = analyzeSource("src/classes.py", Array.from({ length: 240 }, (_, i) => `class Class${i}:\n    def run(self):\n        return ${i}\n`).join("\n"));
  assert.equal(complete.definitions.filter(item => item.kind === "class").length, 240); assert.equal(complete.analysisComplete, true);
  const capped = analyzeSource("src/classes.ts", Array.from({ length: 1100 }, (_, i) => `class Class${i} {}`).join("\n"));
  assert.equal(capped.definitions.length, 1000); assert.equal(capped.analysisComplete, false);
  const invalid = analyzeSource("src/broken.py", "def broken(:\n    return 1");
  assert.equal(invalid.analysisComplete, false);
});
