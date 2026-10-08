import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { getGroqQuotaSnapshot, GroqFreeLimitError } from "@/lib/groq-pool";
import { providerEventStream, providerFailureResponse } from "@/lib/provider-response";
import { ingestRepository, parseRepositoryUrl } from "@/lib/architecture/github";
import { repositoryOwner, saveRepositoryIndex, loadRepositoryIndex } from "@/lib/architecture/index-store";
import { createRepositoryLesson } from "@/lib/architecture/explanation";
import { repositoryInputSchema } from "@/lib/repository-input";
import { withSupportingContext } from "@/lib/architecture/supporting-context";
import { investigateRepository } from "@/lib/architecture/repository-research";

export const runtime = "nodejs";
export const maxDuration = 300;
const requestSchema = z.object({ question: z.string().trim().min(3).max(1000), context: repositoryInputSchema.default({}), contextIndexId: z.string().uuid().optional(), sessionId: z.string().max(120).optional(), preferredGroqKeyId: z.string().max(32).optional(), audience: z.enum(["developer", "cross-team", "leadership"]).default("developer") });
export async function POST(request: NextRequest) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ code: "INVALID_REQUEST", message: "Check the repository URL and supporting context: " + parsed.error.issues[0].message, retryable: false }, { status: 400 });
  const input = parsed.data;
  try { parseRepositoryUrl(input.question); } catch (error) { return providerFailureResponse(error); }
  const ownerKey = await repositoryOwner();
  // Older versions accepted private-repository credentials; public imports never use them.
  (await cookies()).delete("chalkie_github");
  return providerEventStream(request, async (send, signal) => {
    const quota = await getGroqQuotaSnapshot(input.sessionId, input.preferredGroqKeyId);
    send("provider_status", quota);
    const previous = input.contextIndexId ? await loadRepositoryIndex(input.contextIndexId, ownerKey) : undefined;
    const repository = await ingestRepository(input.question, { ownerKey, signal, allowEmptyEvidence: Boolean(input.context.notes || input.context.documents.length || previous?.evidence.some(e => e.origin === "attachment")), onStatus: message => send("status", { stage: "indexing", message }) });
    // Explain public-access failures even when no model key is configured.
    if (quota.allUnavailable) throw new GroqFreeLimitError(quota);
    const index = await investigateRepository(withSupportingContext(repository, input.context, previous), input.context.instructions || "main entry request inference workflow", { signal, freshlyIndexed: true, onStatus: message => send("status", { stage: "retrieving", message }) });
    await saveRepositoryIndex(index);
    send("status", { stage: "visualizing", message: "Mapped " + (index.tree?.length ?? index.files.length) + " files and indexed " + index.files.length + ". Connecting the implementation into a walkthrough…" });
    const lesson = await createRepositoryLesson(index, input.audience, { sessionId: input.sessionId, preferredKeyId: input.preferredGroqKeyId, signal, timeoutMs: 150000, onStatus: status => send("provider_status", status) });
    send("lesson", { lesson, mode: "live" });
  });
}
