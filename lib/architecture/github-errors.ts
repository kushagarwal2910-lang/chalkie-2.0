import { RepositoryError } from "./types";

/** Classify GitHub failures without exposing its raw response or credentials. */
export async function githubFailure(response: Response, authenticated: boolean, now = Date.now()): Promise<RepositoryError> {
  if (response.status === 404) return new RepositoryError("Repository or branch not found. For a private repository, connect a GitHub token with Contents read access in Repository access.", "REPOSITORY_NOT_FOUND", true);
  if (response.status === 401) return new RepositoryError("GitHub rejected your token. Update it in Repository access, then retry. Groq keys are separate.", "GITHUB_AUTH", true);
  if (response.status !== 403 && response.status !== 429) return new RepositoryError("GitHub could not complete the scan. Please retry.", "GITHUB_UNAVAILABLE", true);
  const reader = response.body?.getReader();
  let body = "";
  if (reader) {
    try {
      const decoder = new TextDecoder();
      while (body.length < 8000) { const { value, done } = await reader.read(); if (done) break; body += decoder.decode(value.slice(0, 8000 - body.length)); }
    } catch { /* Rate-limit headers still provide a useful diagnosis. */ }
    finally { await reader.cancel().catch(() => {}); }
  }
  const primary = response.headers.get("x-ratelimit-remaining") === "0";
  const retry = response.headers.get("retry-after");
  if (response.status === 429 || primary || retry !== null || /rate[ -]?limit/i.test(body)) {
    const reset = primary ? Number(response.headers.get("x-ratelimit-reset")) * 1000 : 0;
    const retryAt = retry && /^\d+(?:\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : retry ? Date.parse(retry) : 0;
    const reported = [reset, retryAt].filter(time => Number.isFinite(time) && time > now);
    const nextRetryAt = reported.length ? Math.max(...reported) + 1000 : now + 60000;
    const message = primary
      ? authenticated ? "GitHub's API allowance for the connected account is exhausted. Wait for the GitHub reset time, then retry. Your Groq keys are not responsible for this error."
        : "GitHub's unauthenticated API allowance for this server is exhausted. Connect a GitHub token in Repository access, or wait for the reset time. Adding Groq keys will not increase GitHub's allowance."
      : "GitHub is temporarily rate-limiting repository requests. Wait for the GitHub retry window before trying again. This is separate from Groq's limits.";
    return new RepositoryError(message, "GITHUB_RATE_LIMIT", true, nextRetryAt);
  }
  return new RepositoryError("GitHub denied repository access. Check the token's selected repositories, Contents read permission, and any organization approval or SSO requirements in Repository access.", "GITHUB_ACCESS_DENIED", true);
}
