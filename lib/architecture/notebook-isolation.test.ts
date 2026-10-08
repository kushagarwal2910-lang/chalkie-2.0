import assert from "node:assert/strict";
import test from "node:test";
import { assertNotebookRepository, withSupportingContext } from "./supporting-context";
import { emptyRepositoryInput } from "../repository-input";
import type { RepositoryIndex } from "./types";
import type { LessonPlan } from "../lesson-schema";

function index(name = "alpha", commit = "a".repeat(40)): RepositoryIndex {
  return { version: 1, id: "e11b3f00-1234-4567-9876-abcdef012345", ownerKey: "browser", repository: { owner: "team", name, url: "https://github.com/team/" + name, commit }, createdAt: new Date().toISOString(), discoveredFiles: 1, files: [{ path: "src/main.ts", kind: "source", bytes: 40 }], evidence: [{ id: "e1", path: "src/main.ts", startLine: 1, endLine: 3, kind: "source", text: "export function main() { return '" + name + "'; }" }], warnings: [] };
}

function notebook(saved: RepositoryIndex): Pick<LessonPlan, "repository" | "sources"> {
  return { repository: { indexId: saved.id, name: saved.repository.owner + "/" + saved.repository.name, url: saved.repository.url, commit: saved.repository.commit, indexedFiles: 1, discoveredFiles: 1, warnings: [] }, sources: saved.evidence.map(source => ({ id: source.id, title: source.path, path: source.path, startLine: source.startLine, origin: source.origin, publisher: "GitHub", summary: source.text, score: 1, url: source.origin === "attachment" ? "" : saved.repository.url + "/blob/" + saved.repository.commit + "/" + source.path + "#L1-L3" })) };
}

test("follow-up index identity cannot substitute another repository or commit with the same evidence IDs", () => {
  const saved = index();
  const current = notebook(saved);
  assert.doesNotThrow(() => assertNotebookRepository(saved, current));
  for (const other of [index("beta"), index("alpha", "b".repeat(40)), { ...saved, id: "d22b3f00-1234-4567-9876-abcdef012345" }]) {
    assert.equal(other.evidence[0].id, "e1");
    assert.throws(() => assertNotebookRepository(other, current), { code: "REPOSITORY_MISMATCH" });
  }
});

test("a notebook with matching header metadata still cannot cite another repository's snapshot", () => {
  const saved = index();
  for (const changed of [
    { ...notebook(saved).sources[0], url: notebook(index("beta")).sources[0].url },
    { ...notebook(saved).sources[0], url: notebook(index("alpha", "b".repeat(40))).sources[0].url },
    { ...notebook(saved).sources[0], path: "src/unrelated.ts" },
    { ...notebook(saved).sources[0], startLine: 500 },
    { ...notebook(saved).sources[0], id: "unknown-source" },
    { ...notebook(saved).sources[0], origin: "attachment" as const, url: "" },
  ]) assert.throws(() => assertNotebookRepository(saved, { ...notebook(saved), sources: [changed] }), { code: "REPOSITORY_MISMATCH" });
});

test("attachment identity is retained only in its own snapshot", () => {
  const saved = withSupportingContext(index(), { ...emptyRepositoryInput(), notes: "Alpha is owned by the platform team." });
  assert.doesNotThrow(() => assertNotebookRepository(saved, notebook(saved)));
  const other = index();
  assert.throws(() => assertNotebookRepository(other, notebook(saved)), { code: "REPOSITORY_MISMATCH" });
});

test("explicit same-repository reindexing carries only attachments and teaching instructions across commits", () => {
  const previous = withSupportingContext(index(), { ...emptyRepositoryInput(), instructions: "Teach the platform team", notes: "User-supplied Alpha context." });
  const fresh = { ...index("alpha", "b".repeat(40)), id: "d22b3f00-1234-4567-9876-abcdef012345" };
  const refreshed = withSupportingContext(fresh, emptyRepositoryInput(), previous);
  assert.equal(refreshed.repository.commit, fresh.repository.commit);
  assert.deepEqual(refreshed.evidence.filter(source => source.origin !== "attachment"), fresh.evidence);
  assert.deepEqual(refreshed.evidence.filter(source => source.origin === "attachment"), previous.evidence.filter(source => source.origin === "attachment"));
  assert.equal(refreshed.instructions, previous.instructions);
  const separateNotebook = withSupportingContext(fresh, emptyRepositoryInput());
  assert.equal(separateNotebook.evidence.some(source => source.origin === "attachment"), false);
  assert.equal(separateNotebook.instructions, "");
  assert.throws(() => withSupportingContext(index("beta"), emptyRepositoryInput(), previous), { code: "REPOSITORY_MISMATCH" });
  assert.throws(() => withSupportingContext({ ...fresh, ownerKey: "another-browser" }, emptyRepositoryInput(), previous), { code: "REPOSITORY_MISMATCH" });
});
