import assert from "node:assert/strict";
import test from "node:test";
import { readPublicArchive, type PublicBlueprintSnapshot } from "./github-archive";
import { zipFixture } from "./test-zip-fixture";

const repo = { owner: "team", name: "project", url: "https://github.com/team/project" };
const noAbort = () => new AbortController().signal;
const file = (path: string, text: string) => ({ name: "project-HEAD/" + path, text });
const doc = file("README.md", "# Worker library\nConsumes tasks and writes the documented result.");
const imported = (files: Parameters<typeof zipFixture>[0]) => readPublicArchive(zipFixture(files), repo, noAbort());

test("archive source indexing stores static code evidence, import metadata and a safe full file listing", async () => {
  const secret = "gsk_" + "x".repeat(28);
  const code = [
    'import { runJob } from "./jobs";',
    `const apiKey = "${secret}";`,
    "export async function handleTask(task: string) {",
    "  return await runJob(task);",
    "}",
    "globalThis.__chalkieArchiveExecutionProbe = true;",
  ].join("\n");
  const statuses: string[] = [];
  const snapshot = await readPublicArchive(zipFixture([
    doc, file("src/main.ts", code),
    file("jobs/worker.py", "from pathlib import Path\n\ndef load_job(name):\n    return Path(name).read_text()\n"),
    { ...file("assets/preview.png", "UNREAD_BINARY"), invalidDeflate: true },
    { ...file("LICENSE", "UNREAD_LICENSE"), invalidDeflate: true },
  ]), repo, noAbort(), status => statuses.push(status));
  assert.equal(Reflect.has(globalThis, "__chalkieArchiveExecutionProbe"), false);
  assert.equal(snapshot.discoveredFiles, 3);
  assert.equal(snapshot.tree?.length, 5);
  assert.deepEqual(snapshot.tree?.find(entry => entry.path === "src/main.ts"), { path: "src/main.ts", bytes: Buffer.byteLength(code), kind: "source", language: "typescript" });
  assert.equal(snapshot.tree?.find(entry => entry.path === "assets/preview.png")?.kind, "other");
  assert.equal(snapshot.tree?.find(entry => entry.path === "README.md")?.kind, "blueprint");
  assert.equal(snapshot.files.filter(entry => entry.kind === "source").length, 2);
  const ts = snapshot.sourceFiles?.find(entry => entry.path === "src/main.ts");
  assert.equal(ts?.parser, "typescript-ast"); assert.ok(ts?.imports.includes("./jobs")); assert.ok(ts?.symbols.includes("handleTask"));
  const python = snapshot.sourceFiles?.find(entry => entry.path === "jobs/worker.py");
  assert.equal(python?.parser, "python-cst"); assert.ok(python?.imports.includes("pathlib")); assert.ok(python?.symbols.includes("load_job"));
  assert.ok(snapshot.evidence.some(item => item.kind === "source" && /runJob\(task\)/.test(item.text)));
  assert.equal(new Set(snapshot.evidence.map(item => item.id)).size, snapshot.evidence.length);
  assert.ok(snapshot.evidence.every(item => /^e\d+$/.test(item.id)));
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret + "|UNREAD_BINARY|UNREAD_LICENSE"));
  assert.ok(statuses.some(message => message.startsWith("Reading code")));
  assert.deepEqual(Object.keys(ts!).sort(), ["imports", "language", "parser", "path", "symbols"]);
});

test("sensitive, dependency and generated paths are excluded even from the tree and never decompressed", async () => {
  const ignored = [
    ".env", ".env.example", ".aws/README.md", ".gcloud/settings.py", ".ssh/id_rsa", "keys/service.pem", "credentials.json", "secrets/config.ts", "private_key.txt", ".npmrc",
    "node_modules/package/index.js", "bower_components/widget/widget.js", "third_party/tool/main.py", "vendor/README.md", "dist/app.js", "build/README.md", "generated/app.ts", "src/client.generated.ts", "src/api_pb2.py", "src/types.d.ts", "web/app.bundle.js", "web/app.js.map",
  ];
  const snapshot = await imported([
    doc, ...ignored.map(path => ({ ...file(path, "MUST_NOT_READ"), invalidDeflate: true })),
    { ...file("src/main.ts", "../outside.ts"), mode: 0xa1ff, invalidDeflate: true },
  ]);
  assert.deepEqual(snapshot.tree?.map(entry => entry.path), ["README.md"]);
  assert.deepEqual(snapshot.sourceFiles, []);
  assert.equal(snapshot.discoveredFiles, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /MUST_NOT_READ|outside\.ts/);
});

test("source limits preserve complete safe metadata and prioritize entrypoints without displacing blueprints", async () => {
  const overflow = Array.from({ length: 161 }, (_, i) => file(`misc/feature${String(i).padStart(3, "0")}.ts`, `export function feature${i}() { return ${i}; }`));
  const snapshot = await imported([
    ...overflow, file("src/start.ts", "export function start() { return 'ready'; }"),
    file("app/api/jobs/route.ts", "export function POST() { return 'accepted'; }"),
    file("main.py", "def main():\n    return 'ready'\n"), doc,
  ]);
  assert.equal(snapshot.tree?.length, 165);
  assert.equal(snapshot.discoveredFiles, 165);
  assert.equal(snapshot.sourceFiles?.length, 160);
  assert.equal(snapshot.files.filter(entry => entry.kind !== "source").length, 1);
  assert.equal(snapshot.sourceFiles?.[0].path, "main.py");
  for (const path of ["src/start.ts", "app/api/jobs/route.ts"]) assert.ok(snapshot.sourceFiles?.some(entry => entry.path === path));
  assert.ok(snapshot.warnings.some(message => /164 candidate source files/.test(message) && /partial/.test(message)));
});

test("decompressed source budget is separate from the blueprint budget and stored excerpts stay bounded", async () => {
  const prefix = "export function processTask() { return 'processed'; }\n// ";
  const text = prefix + "x".repeat(100000 - prefix.length);
  const snapshot = await imported([doc, ...Array.from({ length: 40 }, (_, i) => file(`src/task${i}.ts`, text))]);
  const sourceFiles = snapshot.files.filter(entry => entry.kind === "source");
  assert.equal(sourceFiles.length, 31);
  assert.ok(sourceFiles.reduce((bytes, entry) => bytes + entry.bytes, 0) <= 3 * 1024 * 1024);
  assert.ok(snapshot.evidence.filter(entry => entry.kind === "source").reduce((bytes, entry) => bytes + Buffer.byteLength(entry.text), 0) <= 3 * 1024 * 1024);
  assert.ok(snapshot.files.some(entry => entry.path === "README.md"));
  assert.equal(snapshot.tree?.length, 41);
  assert.ok(snapshot.warnings.some(message => /source indexing budget/.test(message)));
  assert.doesNotMatch(JSON.stringify(snapshot), /x{2000}/);
});

test("Python test filenames cannot displace implementation files at the source cap", async () => {
  const tests = Array.from({ length: 160 }, (_, i) => file(`model/a${i}_test.py`, `def test_${i}():\n    assert True\n`));
  const snapshot = await imported([...tests, file("model/z_sampler.py", "def sample(logits):\n    return logits.argmax()\n")]);
  assert.equal(snapshot.sourceFiles?.length, 160);
  assert.equal(snapshot.sourceFiles?.[0].path, "model/z_sampler.py");
  assert.equal(snapshot.tree?.length, 161);
});

test("oversized, binary and generated-content source is not indexed while metadata remains available", async () => {
  const snapshot = await imported([
    doc,
    { ...file("large.ts", "not decompressed"), declaredSize: 128001, invalidDeflate: true },
    file("binary.py", "\0exported bytes"),
    file("client.ts", "// Automatically generated.\nexport function client() { return true; }"),
    file("main.ts", "export function main() { return 42; }"),
  ]);
  assert.equal(snapshot.tree?.length, 5);
  assert.deepEqual(snapshot.sourceFiles?.map(entry => entry.path), ["main.ts"]);
  assert.ok(snapshot.warnings.some(message => /large.ts: skipped.*oversized/.test(message)));
  assert.ok(snapshot.warnings.some(message => /binary.py: skipped binary/.test(message)));
  assert.ok(snapshot.warnings.some(message => /client.ts: no usable source/.test(message)));
  await assert.rejects(imported([{ ...file("main.ts", "export const value = '" + "x".repeat(1000) + "';"), declaredSize: 10 }]), { code: "GITHUB_INVALID_ARCHIVE" });
});

test("old same-commit blueprint snapshots upgrade to source indexes before they can be reused", async () => {
  const previous: PublicBlueprintSnapshot = await imported([doc]);
  delete previous.tree; delete previous.sourceFiles;
  const archive = zipFixture([doc, file("main.py", "def main():\n    return 'ready'\n")]);
  const upgraded = await readPublicArchive(archive, repo, noAbort(), undefined, previous);
  assert.notEqual(upgraded, previous);
  assert.equal(upgraded.sourceFiles?.[0].path, "main.py");
  const reused = await readPublicArchive(archive, repo, noAbort(), undefined, upgraded);
  assert.equal(reused, upgraded);
});

test("cancelling during source analysis preserves cancellation instead of reporting a corrupt archive", async () => {
  const controller = new AbortController();
  await assert.rejects(readPublicArchive(zipFixture([file("main.ts", "export function main() { return 1; }")]), repo, controller.signal, message => {
    if (message.startsWith("Reading code")) controller.abort();
  }), { name: "AbortError" });
});
