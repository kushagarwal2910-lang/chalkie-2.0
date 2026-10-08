import { MAX_CONTEXT_CHARS, repositoryInputSchema, type RepositoryInput } from "../repository-input";
import { redactSecrets } from "./blueprints";
import { RepositoryError, type RepositoryIndex } from "./types";
import type { LessonPlan } from "../lesson-schema";

/** An owner-scoped index ID cannot silently change the repository shown on a board. */
export function assertNotebookRepository(index: RepositoryIndex, lesson: Pick<LessonPlan, "repository" | "sources">) {
  const repository = lesson.repository;
  const mismatch = () => new RepositoryError("This notebook does not match its saved repository snapshot. Reopen the correct notebook or index its repository again.", "REPOSITORY_MISMATCH");
  if (!repository || repository.indexId !== index.id || repository.url !== index.repository.url || repository.commit !== index.repository.commit || repository.name.toLowerCase() !== (index.repository.owner + "/" + index.repository.name).toLowerCase()) throw mismatch();
  const evidence = new Map(index.evidence.map(source => [source.id, source]));
  for (const source of lesson.sources) {
    const saved = evidence.get(source.id);
    if (!saved || source.origin !== saved.origin || (source.path !== undefined && source.path !== saved.path) || (source.startLine !== undefined && source.startLine !== saved.startLine)) throw mismatch();
    if (saved.origin === "attachment") { if (source.url !== "") throw mismatch(); }
    else {
      const expected = index.repository.url + "/blob/" + index.repository.commit + "/" + saved.path.split("/").map(encodeURIComponent).join("/");
      if (source.url.split("#")[0] !== expected) throw mismatch();
    }
  }
}

/** Instructions guide the answer; supporting documents are evidence, never instructions. */
export function withSupportingContext(index: RepositoryIndex, input: RepositoryInput, previous?: RepositoryIndex): RepositoryIndex {
  const context = repositoryInputSchema.parse(input);
  if (previous && (previous.ownerKey !== index.ownerKey || previous.repository.url !== index.repository.url)) throw new RepositoryError("Supporting context belongs to another repository or owner. Start this repository with its own documentation.", "REPOSITORY_MISMATCH");
  const evidence = [...index.evidence, ...(previous?.evidence.filter(e => e.origin === "attachment") ?? [])];
  const documents = [...(context.notes ? [{ name: "Supporting notes", text: context.notes }] : []), ...context.documents];
  if (evidence.filter(e => e.origin === "attachment").reduce((sum, e) => sum + e.text.length, 0) + documents.reduce((sum, doc) => sum + doc.text.length, 0) > MAX_CONTEXT_CHARS) throw new RepositoryError("Supporting documentation exceeds 80,000 characters. Start a new repository walkthrough with the documents you need.", "CONTEXT_TOO_LARGE");
  const prefix = "u" + crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  for (const doc of documents) {
    const lines = redactSecrets(doc.text).split(/\r?\n/);
    let text = "", startLine = 1, endLine = 1;
    const add = () => {
      if (text.trim()) evidence.push({ id: `${prefix}_${evidence.length}`, path: redactSecrets(doc.name), origin: "attachment", kind: "documentation", text, startLine, endLine });
      text = "";
    };
    for (let line = 0; line < lines.length; line++) {
      // Preserve all text, including long lines, without producing oversized chunks.
      for (let offset = 0; offset < Math.max(1, lines[line].length); offset += 1800) {
        const part = lines[line].slice(offset, offset + 1800);
        if (text.length + part.length + 1 > 2200) add();
        if (!text) startLine = line + 1;
        text += (text ? "\n" : "") + part;
        endLine = line + 1;
      }
    }
    add();
  }
  return { ...index, evidence, instructions: redactSecrets(context.instructions || previous?.instructions || "") };
}
