import { traceDebug } from "../../../runtime/observability/debug-logger.js";
import type { OllamaSchemaProjectionDiagnostic } from "../../structured-output/projection.js";
import type { ResolvedModelInvocation } from "../../types.js";
import type { ModelProviderInvocationParams } from "../contracts.js";
import type { OllamaProviderTiming } from "./stream-normalizer.js";
import { readEffectiveOption } from "./options.js";

function readRecord(value: unknown): Record<string, unknown> | undefined {
  const isRecord =
    value !== null && typeof value === "object" && !Array.isArray(value);
  return isRecord ? (value as Record<string, unknown>) : undefined;
}

function resolveRequestedFormatKind(
  requestedFormat: unknown,
): "none" | "json" | "json_schema" | "schema" {
  if (requestedFormat === undefined) {
    return "none";
  }
  if (requestedFormat === "json") {
    return "json";
  }
  const formatRecord = readRecord(requestedFormat);
  return formatRecord?.type === "json_schema" ? "json_schema" : "schema";
}

function resolveProviderFormatKind(
  projectedFormat: unknown,
): "none" | "json" | "schema" {
  if (projectedFormat === undefined) {
    return "none";
  }
  return projectedFormat === "json" ? "json" : "schema";
}

function countObjectProperties(value: unknown): number {
  const record = readRecord(value);
  return record ? Object.keys(record).length : 0;
}

function countArrayItems(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function resolveOllamaBaseUrl(
  invocation: ResolvedModelInvocation,
  fallbackUrl: string,
): string {
  return invocation.profile.providerConfig?.baseUrl?.trim() || fallbackUrl;
}

export function emitOllamaSchemaDiagnostics(
  requestId: string,
  diagnostics: readonly OllamaSchemaProjectionDiagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    traceDebug("model-gateway.server", "schema.projection.constraint_removed", {
      requestId,
      provider: "ollama",
      action: diagnostic.action,
      keyword: diagnostic.keyword,
      path: diagnostic.path,
      reason: diagnostic.reason,
    });
  }
}

export function emitOllamaRequestProjection(params: {
  invocationParams: ModelProviderInvocationParams;
  payload: Record<string, unknown>;
  removedConstraintCount: number;
}): void {
  const { requestBody, invocation, endpoint } = params.invocationParams;
  const projectedFormat = params.payload.format;
  const projectedSchema = readRecord(projectedFormat);
  traceDebug("model-gateway.server", "provider.request.projected", {
    requestId:
      typeof requestBody.debugRequestId === "string"
        ? requestBody.debugRequestId
        : "",
    endpoint,
    modelStep: requestBody.modelStep,
    profileId: invocation.profile.id,
    providerId: invocation.profile.providerId,
    provider: "ollama",
    model: invocation.model,
    requestedFormatKind: resolveRequestedFormatKind(requestBody.format),
    providerFormatKind: resolveProviderFormatKind(projectedFormat),
    providerSchemaCharacterCount: projectedSchema
      ? JSON.stringify(projectedSchema).length
      : 0,
    providerSchemaRootType:
      typeof projectedSchema?.type === "string"
        ? projectedSchema.type.slice(0, 64)
        : "",
    providerSchemaRootPropertyCount: countObjectProperties(
      projectedSchema?.properties,
    ),
    providerSchemaRootOneOfVariantCount: countArrayItems(
      projectedSchema?.oneOf,
    ),
    providerSchemaRootAnyOfVariantCount: countArrayItems(
      projectedSchema?.anyOf,
    ),
    providerSchemaRootAllOfVariantCount: countArrayItems(
      projectedSchema?.allOf,
    ),
    removedConstraintCount: params.removedConstraintCount,
    providerContextTokenLimit: readEffectiveOption(params.payload, "num_ctx"),
    providerOutputTokenLimit: readEffectiveOption(
      params.payload,
      "num_predict",
    ),
  });
}

export function emitOllamaTiming(params: {
  invocationParams: ModelProviderInvocationParams;
  payload: Record<string, unknown>;
  timing: OllamaProviderTiming;
}): void {
  const { requestBody, invocation, endpoint } = params.invocationParams;
  const measuredDurationNs =
    (params.timing.loadDurationNs ?? 0) +
    (params.timing.promptEvalDurationNs ?? 0) +
    (params.timing.evalDurationNs ?? 0);
  const remainingDurationNs =
    params.timing.totalDurationNs === undefined
      ? undefined
      : Math.max(0, params.timing.totalDurationNs - measuredDurationNs);
  traceDebug("model-gateway.server", "ollama.invocation.timing", {
    requestId:
      typeof requestBody.debugRequestId === "string"
        ? requestBody.debugRequestId
        : "",
    endpoint,
    modelStep: requestBody.modelStep,
    profileId: invocation.profile.id,
    providerId: invocation.profile.providerId,
    model: invocation.model,
    numCtx: readEffectiveOption(params.payload, "num_ctx"),
    numPredict: readEffectiveOption(params.payload, "num_predict"),
    ...params.timing,
    ...(remainingDurationNs !== undefined ? { remainingDurationNs } : {}),
  });
}
