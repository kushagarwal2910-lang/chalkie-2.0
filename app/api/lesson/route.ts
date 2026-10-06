import type { NextRequest } from "next/server";
import { z } from "zod";
import { getGroqQuotaSnapshot, GroqFreeLimitError } from "@/lib/groq-pool";
import { providerEventStream, providerFailureResponse } from "@/lib/provider-response";
import { ingestRepository, parseRepositoryUrl } from "@/lib/architecture/github";
import { githubToken, repositoryOwner, saveRepositoryIndex } from "@/lib/architecture/index-store";
import { createRepositoryLesson } from "@/lib/architecture/explanation";

export const runtime = "nodejs";
export const maxDuration = 300;
const requestSchema = z.object({ question: z.string().trim().min(3).max(1000), sessionId: z.string().max(120).optional(), preferredGroqKeyId: z.string().max(32).optional(), audience: z.enum(["developer", "cross-team", "leadership"]).default("developer") });
export async function POST(request: NextRequest) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ code: "INVALID_REQUEST", message: "Paste a valid GitHub repository URL.", retryable: false }, { status: 400 });
  const input = parsed.data;
  try { parseRepositoryUrl(input.question); } catch (error) { return providerFailureResponse(error); }
  const ownerKey = await repositoryOwner();
  const token = await githubToken();
  return providerEventStream(request, async (send, signal) => {
    const quota = await getGroqQuotaSnapshot(input.sessionId, input.preferredGroqKeyId);
    send("provider_status", quota);
    if (quota.allUnavailable) throw new GroqFreeLimitError(quota);
    const index = await ingestRepository(input.question, { ownerKey, token, signal, onStatus: message => send("status", { stage: "indexing", message }) });
    await saveRepositoryIndex(index);
    send("status", { stage: "visualizing", message: "Indexed " + index.files.length + " blueprints. Designing your architecture walkthrough…" });
    const lesson = await createRepositoryLesson(index, input.audience, { sessionId: input.sessionId, preferredKeyId: input.preferredGroqKeyId, signal, timeoutMs: 150000, onStatus: status => send("provider_status", status) });
    send("lesson", { lesson, mode: "live" });
  });
}
