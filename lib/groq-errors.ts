import type { GroqHttpError } from "./groq-pool-core";

/** Classify errors without exposing prompts, failed generations, or credentials. */
export function groqErrorDetails(error: GroqHttpError) {
  let data: { code?: unknown; type?: unknown; param?: unknown; message?: unknown } = {};
  try { data = JSON.parse(error.body)?.error ?? {}; } catch { /* non-JSON provider error */ }
  const codes = ["json_validate_failed", "invalid_json_schema", "invalid_schema", "context_length_exceeded", "model_not_found", "model_decommissioned", "rate_limit_exceeded", "content_filter", "invalid_request_error"];
  const parameters = ["response_format", "response_format.json_schema", "max_completion_tokens", "max_tokens", "messages", "model", "temperature", "reasoning_effort"];
  const providerCode = typeof data.code === "string" && codes.includes(data.code) ? data.code : "unknown";
  const parameter = typeof data.param === "string" && parameters.includes(data.param) ? data.param : undefined;
  const message = typeof data.message === "string" ? data.message : "";
  const category = providerCode === "json_validate_failed" ? "invalid_output"
    : error.status === 413 || providerCode === "context_length_exceeded" || /request too large|maximum context length|context length exceeded/i.test(message) ? "request_size"
    : ["invalid_json_schema", "invalid_schema"].includes(providerCode) || /invalid (?:json )?schema|schema.*(?:not supported|unsupported)/i.test(message) ? "invalid_schema"
    : ["model_not_found", "model_decommissioned"].includes(providerCode) ? "model_unavailable"
    : error.status === 400 || error.status === 422 ? "request_rejected"
    : "unavailable";
  return { status: error.status, category, providerCode, ...(parameter ? { parameter } : {}) };
}
