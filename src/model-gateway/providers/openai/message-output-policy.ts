import type { ModelGatewayRequest } from "../../types.js";

/** Content authoring consumes one message even when its wire format is plain text. */
export function requiresSingleMessageOutput(
  request: ModelGatewayRequest,
  payload: Record<string, unknown>,
): boolean {
  if (request.modelStep === "tool_payload.raw") return true;
  return hasStructuredTextFormat(payload);
}

function hasStructuredTextFormat(payload: Record<string, unknown>): boolean {
  const text = readRecord(payload.text);
  const format = readRecord(text?.format);
  return format?.type === "json_schema" || format?.type === "json_object";
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
