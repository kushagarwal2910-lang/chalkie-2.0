import { resolveProviderCredentials } from "./provider-credentials";
import { GroqPool, GroqHttpError, type GroqCallOptions } from "./groq-pool-core.ts";
import { groqErrorDetails } from "./groq-errors";

export {
  GroqFreeLimitError, GroqHttpError, GroqRequestTimeoutError,
  type GroqCallOptions, type GroqKeyQuota, type GroqKeyStatus, type GroqQuotaSnapshot, type DegradationReason,
} from "./groq-pool-core.ts";

declare global { var chalkieGroqPoolV2: GroqPool | undefined; }
const pool = globalThis.chalkieGroqPoolV2 ??= new GroqPool();

// Retained only for old clients; a status read never reorders the server queue.
export async function getGroqQuotaSnapshot(sessionId?: string, _preferredKeyId?: string) {
  void _preferredKeyId;
  const credentials = await resolveProviderCredentials();
  return pool.getSnapshot(credentials.groqKeys, credentials.source, sessionId);
}

export async function groqFetch(path: string, init: RequestInit, options: GroqCallOptions = {}) {
  const credentials = await resolveProviderCredentials();
  try { return await pool.fetch(credentials.groqKeys, credentials.source, path, init, options); }
  catch (error) {
    if (error instanceof GroqHttpError) console.warn("[chalkie:groq]", JSON.stringify(groqErrorDetails(error)));
    throw error;
  }
}
