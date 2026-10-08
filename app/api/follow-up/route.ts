import type { NextRequest } from "next/server";
import { z } from "zod";
import { getGroqQuotaSnapshot, GroqFreeLimitError } from "@/lib/groq-pool";
import { providerEventStream } from "@/lib/provider-response";
import { lessonPlanSchema } from "@/lib/lesson-schema";
import { loadRepositoryIndex, repositoryOwner, saveRepositoryIndex } from "@/lib/architecture/index-store";
import { createRepositoryFollowUp } from "@/lib/architecture/explanation";
import { RepositoryError } from "@/lib/architecture/types";
import { investigateRepository } from "@/lib/architecture/repository-research";
import { assertNotebookRepository } from "@/lib/architecture/supporting-context";

export const runtime = "nodejs";
export const maxDuration = 300;
const requestSchema = z.object({ question: z.string().trim().min(2).max(1000), sessionId: z.string().min(1).max(120), currentLesson: lessonPlanSchema, audience: z.enum(["developer", "cross-team", "leadership"]).default("developer") });
export async function POST(request: NextRequest) {
  let input: z.infer<typeof requestSchema>;
  try { input = requestSchema.parse(await request.json()); }
  catch { return Response.json({ code: "INVALID_REQUEST", message: "The follow-up or saved diagram is invalid.", retryable: false }, { status: 400 }); }
  const ownerKey = await repositoryOwner();
  return providerEventStream(request, async (send, signal) => {
    if (!input.currentLesson.repository) throw new RepositoryError("This is a legacy lesson. Paste a GitHub URL to start a repository walkthrough.", "LEGACY_LESSON");
    if (input.currentLesson.segments.length > 220) throw new RepositoryError("This walkthrough has reached its saved step limit. Start another walkthrough of this repository.", "SESSION_LIMIT");
    const saved = await loadRepositoryIndex(input.currentLesson.repository.indexId, ownerKey);
    assertNotebookRepository(saved, input.currentLesson);
    const quota = await getGroqQuotaSnapshot(input.sessionId);
    send("provider_status", quota);
    if (quota.allUnavailable) throw new GroqFreeLimitError(quota);
    send("status", { stage: "retrieving", message: "Searching repository structure, code symbols and related implementation" });
    const index = await investigateRepository(saved, input.question, { signal, onStatus: message => send("status", { stage: "retrieving", message }) });
    await saveRepositoryIndex(index);
    const plan = await createRepositoryFollowUp(index, input.question, input.currentLesson, input.audience, { sessionId: input.sessionId, signal, timeoutMs: 150000, onStatus: status => send("provider_status", status) });
    send("decision", { coverage: plan.coverage, targetIds: plan.targetIds, title: plan.title });
    send("followup", { plan });
  });
}
