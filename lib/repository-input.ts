import { z } from "zod";

export const MAX_DOCUMENTS = 5;
export const MAX_DOCUMENT_CHARS = 20_000;
export const MAX_CONTEXT_CHARS = 80_000;
export const repositoryInputSchema = z.object({
  instructions: z.string().trim().max(2000).default(""),
  notes: z.string().trim().max(MAX_DOCUMENT_CHARS).default(""),
  documents: z.array(z.object({
    name: z.string().trim().min(1).max(120).refine(name => !/[\\/\u0000-\u001f]/.test(name), "Use a filename without directory paths."),
    text: z.string().trim().min(1).max(MAX_DOCUMENT_CHARS),
  }).strict()).max(MAX_DOCUMENTS).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.notes.length + value.documents.reduce((sum, doc) => sum + doc.text.length, 0) > MAX_CONTEXT_CHARS) {
    ctx.addIssue({ code: "custom", message: "Supporting documentation must total at most 80,000 characters." });
  }
});
export type RepositoryInput = z.infer<typeof repositoryInputSchema>;
export const emptyRepositoryInput = (): RepositoryInput => ({ instructions: "", notes: "", documents: [] });

/** Keep document contents out of navigation URLs and browser history. */
export function saveRepositoryDraft(value: RepositoryInput): string {
  const id = crypto.randomUUID();
  sessionStorage.setItem("chalkie:repository-draft:" + id, JSON.stringify(repositoryInputSchema.parse(value)));
  return id;
}
export function takeRepositoryDraft(id: string | null): RepositoryInput {
  if (!id || !/^[a-f0-9-]{36}$/.test(id)) return emptyRepositoryInput();
  const key = "chalkie:repository-draft:" + id;
  const raw = sessionStorage.getItem(key);
  if (!raw) throw new Error("Your supporting context is no longer available in this tab. Add it again before starting.");
  const value = repositoryInputSchema.parse(JSON.parse(raw));
  sessionStorage.removeItem(key);
  return value;
}
