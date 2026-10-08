import assert from "node:assert/strict";
import test from "node:test";
import { createRepositoryFollowUp, createRepositoryLesson } from "./explanation";
import { listRepositoryMap, modelRepositoryMap } from "./repository-map";
import type { Evidence, RepositoryIndex } from "./types";
import type { LessonPlan } from "../lesson-schema";

function fixture(): RepositoryIndex {
  return { version: 1, analysisVersion: 2, id: "context-test", ownerKey: "test", createdAt: new Date().toISOString(),
    repository: { owner: "team", name: "library", url: "https://github.com/team/library", commit: "a".repeat(40) }, files: [], evidence: [], warnings: [], discoveredFiles: 0, tree: [], sourceFiles: [] };
}

test("answer-bearing code survives a crowded old diagram and reaches the model", async () => {
  const index = fixture();
  index.evidence = Array.from({ length: 8 }, (_, i) => ({ id: "old" + i, path: `docs/old${i}.md`, kind: "documentation", startLine: 1, endLine: 10, text: `Old${i} is a documented component. ` + "General setup information about this component. ".repeat(40) }));
  const answer: Evidence = { id: "new-answer", path: "src/processing.ts", kind: "source", startLine: 400, endLine: 403, text: "function distinctProcessingWork(attempt) {\n  if (attempt >= 3) return 'stop';\n  return 'queue';\n}" };
  index.evidence.push(answer);
  index.tree = [{ path: answer.path, bytes: 12000, kind: "source", language: "typescript" }];
  index.sourceFiles = [{ path: answer.path, language: "typescript", parser: "typescript-ast", analysisComplete: true, imports: [], symbols: ["distinctProcessingWork"], definitions: [{ name: "distinctProcessingWork", kind: "function", startLine: 400, endLine: 403 }] }];
  const current: LessonPlan = { id: "old-board", title: "Old subsystem walkthrough", question: index.repository.url, summary: "Old architecture", diagramType: "system", visualStrategy: "", sources: [], connections: [], segments: [],
    objects: index.evidence.slice(0, 8).map((source, i) => ({ id: "n" + i, label: "Old" + i, description: "Old component", kind: "service", evidenceIds: [source.id], role: "component", shapeType: "custom", labelPlacement: "inside", x: 0, y: 0, width: 100, height: 100, parts: [] })) };
  let requests = 0;
  await assert.rejects(createRepositoryFollowUp(index, "How does distinctProcessingWork decide whether to stop?", current, "developer", {}, async (_url, init) => {
    requests++;
    const body = String(init.body), request = JSON.parse(body), context = JSON.parse(request.messages[1].content);
    assert.ok(Buffer.byteLength(body) <= 14000);
    assert.equal(request.max_completion_tokens, 4000);
    assert.ok(context.evidence.some((source: Evidence) => source.id === answer.id && source.text.includes("attempt >= 3")));
    assert.equal(context.repositoryMap.mappedFiles, 1);
    assert.ok(context.repositoryMap.files.some((file: { definitions: string[] }) => file.definitions.some(symbol => symbol.includes("distinctProcessingWork:400-403"))));
    throw new Error("captured request");
  }), /captured request/);
  assert.equal(requests, 1);
});

test("a beginner contributor question asks for substantive teaching, not a compressed diagram inventory", async () => {
  const index = fixture();
  index.instructions = "I am a beginner and want to contribute. Help me figure out the codebase.";
  index.evidence = [{ id: "guide", path: "CONTRIBUTING.md", startLine: 1, endLine: 1, kind: "documentation", text: "Run pytest for the package tests. Add a regression test for a behavior change." }];
  await assert.rejects(createRepositoryLesson(index, "developer", {}, async (_url, init) => {
    const request = JSON.parse(String(init.body));
    assert.match(request.messages[0].content, /Beginner means define jargon/);
    assert.match(request.messages[0].content, /6-10 teaching steps/);
    assert.doesNotMatch(request.messages[0].content, /3-6 steps|Summary <=100 words|3 steps/);
    assert.equal(JSON.parse(request.messages[1].content).explanationFocus, index.instructions);
    throw new Error("captured request");
  }), /captured request/);
});

test("the complete paged map exposes late-file definitions independently of overview excerpts", () => {
  const index = fixture();
  for (let i = 0; i < 240; i++) {
    const path = `package/module${String(i).padStart(3, "0")}.py`;
    index.tree!.push({ path, bytes: 1000, kind: "source", language: "python" });
    index.sourceFiles!.push({ path, parser: "python-cst", language: "python", imports: [], symbols: ["uniqueTask" + i], definitions: [{ name: "uniqueTask" + i, kind: "function", startLine: 20, endLine: 30 }], analysisComplete: true });
  }
  const matches = listRepositoryMap(index, "uniqueTask239");
  assert.equal(matches.definitionCount, 240);
  assert.equal(matches.total, 1);
  assert.equal(matches.files[0].definitions[0].name, "uniqueTask239");
  const paths = [0, 60, 120, 180].flatMap(offset => listRepositoryMap(index, "", offset).files.map(file => file.path));
  assert.equal(new Set(paths).size, 240);
  const map = modelRepositoryMap(index, "uniqueTask239", []);
  assert.equal(map.mappedFiles, 240);
  assert.ok(map.files.some(file => file.path.endsWith("239.py")));
  assert.match(map.listing, /subset/);
  assert.ok(JSON.stringify(map).length <= 2400);
});

test("packed onboarding retains RST project purpose, contributor instructions and real implementation", async () => {
  const index = fixture();
  index.instructions = "I am a beginner and want to contribute to this repo. Help me figure out the codebase.";
  index.evidence = [
    { id: "purpose", path: "README.rst", kind: "documentation", startLine: 1, endLine: 12, text: "SignalKit is a library for processing observations into measurements. " + "The supported workflow processes an input observation and returns a measurement. ".repeat(12) },
    ...Array.from({ length: 10 }, (_, i): Evidence => ({ id: "guide" + i, path: "CONTRIBUTING.md", kind: "documentation", startLine: 1 + i * 20, endLine: 20 + i * 20, text: "Contribute as a beginner by running the documented package checks. " + "New contributors should add tests that exercise changed behavior. ".repeat(20) })),
    { id: "exports", path: "signalkit/__init__.py", kind: "source", startLine: 1, endLine: 2, text: "from .processor import Processor\n__all__ = ['Processor']" },
    { id: "body", path: "signalkit/processor.py", kind: "source", startLine: 1, endLine: 7, text: "class Processor:\n    def process(self, values):\n        valid = [value for value in values if value > 0]\n        return sum(valid) / len(valid) if valid else None" },
  ];
  index.tree = [...new Set(index.evidence.map(source => source.path))].map(path => ({ path, bytes: 10000, kind: path.endsWith(".py") ? "source" : "blueprint" }));
  index.sourceFiles = [{ path: "signalkit/processor.py", language: "python", parser: "python-cst", imports: [], symbols: ["Processor", "process"], analysisComplete: true, definitions: [{ name: "Processor", kind: "class", startLine: 1, endLine: 7 }, { name: "process", kind: "method", startLine: 2, endLine: 7 }] }];
  await assert.rejects(createRepositoryLesson(index, "developer", {}, async (_url, init) => {
    const request = JSON.parse(String(init.body)), context = JSON.parse(request.messages[1].content);
    assert.ok(context.evidence.some((source: Evidence) => source.id === "purpose"));
    assert.ok(context.evidence.some((source: Evidence) => source.path === "CONTRIBUTING.md"));
    assert.ok(context.evidence.some((source: Evidence) => source.id === "body" && source.text.includes("return sum(valid)")));
    assert.ok(context.repositoryMap.files.some((file: { definitions: string[] }) => file.definitions.some(symbol => symbol.includes("class Processor"))));
    throw new Error("captured request");
  }), /captured request/);
});
