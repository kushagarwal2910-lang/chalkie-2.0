import assert from "node:assert/strict";
import test from "node:test";
import { NotebookRestoreGate, notebookLocation } from "./notebook-navigation";
import { loadLessonById, loadRecentLessons, saveCurrentLesson } from "./client-storage";
import type { LessonPlan } from "./lesson-schema";

test("new notebook navigation replaces the old ID and one-shot prompt instead of restoring the previous repository on reload", () => {
  const result = notebookLocation({ pathname: "/studio", search: "?id=old-repository&q=https%3A%2F%2Fgithub.com%2Fteam%2Fnew&draft=old-context&audience=developer" }, "new-notebook");
  const params = new URL(result, "https://chalkie.example").searchParams;
  assert.equal(params.get("id"), "new-notebook");
  assert.equal(params.get("audience"), "developer");
  assert.equal(params.has("q"), false); assert.equal(params.has("draft"), false);
  assert.equal(notebookLocation({ pathname: "/studio", search: "?id=old-notebook" }), "/studio");
});

test("out-of-order saved notebook loads cannot replace a later navigation or generated result", async () => {
  const gate = new NotebookRestoreGate();
  let displayed = "initial";
  const first = gate.begin();
  let resolveFirst!: () => void;
  const delayed = new Promise<void>(resolve => { resolveFirst = resolve; }).then(() => { if (first()) displayed = "old-notebook"; });
  const second = gate.begin();
  if (second()) displayed = "new-notebook";
  resolveFirst(); await delayed;
  assert.equal(displayed, "new-notebook");
  const third = gate.begin();
  gate.cancel(); displayed = "generated-notebook";
  if (third()) displayed = "saved-notebook";
  assert.equal(displayed, "generated-notebook");
});

test("ID-keyed persistence keeps independent notebooks for the same repository and refuses mismatched cache objects", async t => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } } });
  t.after(() => { if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow); else Reflect.deleteProperty(globalThis, "window"); });
  const first = { id: "repo-one", question: "https://github.com/team/project", title: "First commit and context" } as LessonPlan;
  const second = { id: "repo-two", question: first.question, title: "Second commit and context" } as LessonPlan;
  await saveCurrentLesson(first); await saveCurrentLesson(second);
  assert.deepEqual((await loadRecentLessons()).map(lesson => lesson.id), ["repo-two", "repo-one"]);
  assert.equal((await loadLessonById("repo-one"))?.title, first.title);
  assert.equal((await loadLessonById("repo-two"))?.title, second.title);
  storage.set("chalkie:lesson:unavailable", JSON.stringify(second));
  assert.equal(await loadLessonById("unavailable"), null);
});
