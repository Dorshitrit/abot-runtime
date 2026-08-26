import type { WorkerCapabilityPayloadAuthoringResult } from "../../orchestration/worker-capabilities/index.js";
import { validateJsonSchemaValue } from "../../model/json-schema-value.js";
import { isPlainRecord } from "./values.js";

export function normalizePayloadAuthoringResult(
  input: unknown,
  minBytes: number,
  maxBytes: number,
  responseFormat?: "json" | Readonly<Record<string, unknown>>,
):
  | WorkerCapabilityPayloadAuthoringResult
  | Readonly<{ status: "failed"; code: "payload_author_result_invalid" }> {
  if (!isPlainRecord(input) || Object.keys(input).length !== 2) {
    return Object.freeze({
      status: "failed" as const,
      code: "payload_author_result_invalid" as const,
    });
  }
  if (input.status === "authored" && typeof input.body === "string") {
    const body = normalizeAdapterAuthoredBody(input.body, responseFormat);
    if (body === undefined) {
      return Object.freeze({
        status: "failed" as const,
        code: "payload_model_output_invalid" as const,
      });
    }
    const payloadBytes = Buffer.byteLength(body, "utf8");
    if (payloadBytes < minBytes) {
      return Object.freeze({
        status: "failed" as const,
        code: "payload_body_too_small" as const,
      });
    }
    if (payloadBytes <= maxBytes) {
      return Object.freeze({ status: "authored" as const, body });
    }
  }
  if (input.status === "failed" && isPayloadAuthorFailureCode(input.code)) {
    return Object.freeze({ status: "failed" as const, code: input.code });
  }
  return Object.freeze({
    status: "failed" as const,
    code: "payload_author_result_invalid" as const,
  });
}

function normalizeAdapterAuthoredBody(
  body: string,
  responseFormat: "json" | Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (!responseFormat) return body;
  try {
    const parsed = JSON.parse(body);
    if (
      responseFormat !== "json" &&
      validateJsonSchemaValue(responseFormat, parsed)
    ) {
      return undefined;
    }
    return JSON.stringify(parsed);
  } catch {
    return undefined;
  }
}

function isPayloadAuthorFailureCode(
  input: unknown,
): input is Extract<
  WorkerCapabilityPayloadAuthoringResult,
  { status: "failed" }
>["code"] {
  return (
    input === "payload_context_invalid" ||
    input === "payload_context_budget_exceeded" ||
    input === "payload_model_unavailable" ||
    input === "payload_model_invocation_failed" ||
    input === "payload_model_output_invalid" ||
    input === "payload_body_too_small" ||
    input === "payload_body_too_large"
  );
}
