import { RepositoryError } from "./types";

/** Classify GitHub failures without exposing its raw response or credentials. */
export async function githubFailure(response: Response, now = Date.now()): Promise<RepositoryError> {
  if (response.status === 404 || response.status === 401) {
    await response.body?.cancel().catch(() => {});
    return new RepositoryError("This repository or branch is not publicly accessible or does not exist. Chalkie supports public repositories only; private repositories cannot be imported.", "PUBLIC_REPOSITORY_REQUIRED");
  }
  if (response.status !== 403 && response.status !== 429) {
    await response.body?.cancel().catch(() => {});
    return new RepositoryError("GitHub could not complete the public repository download. Please retry.", "GITHUB_UNAVAILABLE", true);
  }
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
    const message = "GitHub is temporarily limiting public archive downloads. Wait for the retry window. No GitHub token is needed, and adding Groq keys will not change this limit.";
    return new RepositoryError(message, "GITHUB_RATE_LIMIT", true, nextRetryAt);
  }
  return new RepositoryError("GitHub denied this public archive download. Check that the repository is public and accessible. Private repositories are not supported.", "GITHUB_ACCESS_DENIED");
}
