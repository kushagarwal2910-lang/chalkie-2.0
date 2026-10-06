import assert from "node:assert/strict";
import { test } from "node:test";
import { GroqHttpError } from "./groq-pool-core";
import { groqErrorDetails } from "./groq-errors";
import { providerFailure } from "./provider-response";

test("Groq diagram, size, schema, and model rejections have distinct guidance", () => {
  for (const [status, code, expected, retryable] of [
    [400, "json_validate_failed", "PROVIDER_INVALID_OUTPUT", true],
    [413, "unknown", "PROVIDER_REQUEST_SIZE", false],
    [400, "context_length_exceeded", "PROVIDER_REQUEST_SIZE", false],
    [400, "invalid_json_schema", "PROVIDER_INVALID_SCHEMA", false],
    [404, "model_not_found", "PROVIDER_MODEL_UNAVAILABLE", false],
    [400, "unknown", "PROVIDER_REQUEST_REJECTED", false],
  ] as const) {
    const result = providerFailure(new GroqHttpError(status, JSON.stringify({ error: { code } })));
    assert.equal(result.failure.code, expected);
    assert.equal(result.failure.retryable, retryable);
    assert.doesNotMatch(result.failure.message, /Check your provider settings/);
  }
});

test("diagnostics and client failures exclude arbitrary provider text and failed generations", () => {
  const secret = "gsk_test_secret_never_show_this";
  const privateText = "Internal roadmap and document contents";
  const error = new GroqHttpError(400, JSON.stringify({ error: { code: secret, type: secret, param: secret, message: privateText, failed_generation: privateText } }));
  const output = JSON.stringify({ diagnostic: groqErrorDetails(error), public: providerFailure(error) });
  assert.ok(!output.includes(secret));
  assert.ok(!output.includes(privateText));
  assert.deepEqual(groqErrorDetails(error), { status: 400, category: "request_rejected", providerCode: "unknown" });
});

test("non-JSON responses remain safe and useful", () => {
  const error = new GroqHttpError(503, "<html>unavailable</html>");
  assert.equal(providerFailure(error).failure.code, "PROVIDER_UNAVAILABLE");
  assert.equal(providerFailure(error).failure.retryable, true);
  assert.deepEqual(groqErrorDetails(new GroqHttpError(400, JSON.stringify({ error: { code: "invalid_request_error", param: "response_format", message: "invalid JSON schema" } }))), {
    status: 400, category: "invalid_schema", providerCode: "invalid_request_error", parameter: "response_format",
  });
});
