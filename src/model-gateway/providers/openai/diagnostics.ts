import { traceDebug } from "../../../runtime/observability/debug-logger.js";
import type { OpenAISchemaProjectionDiagnostic } from "../../structured-output/projection.js";
import type { ModelProviderInvocationParams } from "../contracts.js";
import type { OpenAIMessageOutputNormalizationDiagnostic } from "./stream-normalizer.js";

export type OpenAIStreamTerminationOutcome = "completed" | "aborted" | "failed";

function serializeDiagnosticError(error: unknown): {
  name: string;
  message: string;
} {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  const isRecord =
    value !== null && typeof value === "object" && !Array.isArray(value);
  return isRecord ? (value as Record<string, unknown>) : undefined;
}

export function hasStructuredTextFormat(
  payload: Record<string, unknown>,
): boolean {
  const text = readRecord(payload.text);
  const format = readRecord(text?.format);
  return format?.type === "json_schema" || format?.type === "json_object";
}

export function emitOpenAISchemaDiagnostics(
  requestId: string,
  diagnostics: readonly OpenAISchemaProjectionDiagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    traceDebug(
      "model-gateway.server",
      "schema.projection.instruction_injected",
      {
        requestId,
        provider: "openai",
        action: diagnostic.action,
        schemaName: diagnostic.schemaName,
        reason: diagnostic.reason,
        instructionCharacterCount: diagnostic.instructionCharacterCount,
      },
    );
  }
}

export function emitOpenAIMessageOutputDiagnostic(
  params: ModelProviderInvocationParams,
  diagnostic: OpenAIMessageOutputNormalizationDiagnostic,
): void {
  traceDebug("model-gateway.server", "openai.message_outputs.normalized", {
    requestId:
      typeof params.requestBody.debugRequestId === "string"
        ? params.requestBody.debugRequestId
        : "",
    modelStep:
      typeof params.requestBody.modelStep === "string"
        ? params.requestBody.modelStep
        : "",
    provider: "openai",
    endpoint: params.endpoint,
    ...diagnostic,
  });
}

export function resolveOpenAIStreamFailureOutcome(
  error: unknown,
): OpenAIStreamTerminationOutcome {
  const isAbort =
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError";
  return isAbort ? "aborted" : "failed";
}

export function emitOpenAIStreamTermination(params: {
  invocationParams: ModelProviderInvocationParams;
  startedAt: number;
  outcome: OpenAIStreamTerminationOutcome;
  error?: unknown;
}): void {
  const { requestBody, invocation, endpoint } = params.invocationParams;
  const hasAbortReason =
    params.outcome === "aborted" && params.error !== undefined;
  traceDebug("model-gateway.server", "openai.stream.terminated", {
    requestId:
      typeof requestBody.debugRequestId === "string"
        ? requestBody.debugRequestId
        : "",
    endpoint,
    modelStep:
      typeof requestBody.modelStep === "string" ? requestBody.modelStep : "",
    profileId: invocation.profile.id,
    providerId: invocation.profile.providerId,
    provider: "openai",
    model: invocation.model,
    elapsedMs: Date.now() - params.startedAt,
    outcome: params.outcome,
    abortRequested: params.outcome === "aborted",
    ...(hasAbortReason
      ? { abortReason: serializeDiagnosticError(params.error) }
      : {}),
    ...(params.error !== undefined
      ? { error: serializeDiagnosticError(params.error) }
      : {}),
  });
}
