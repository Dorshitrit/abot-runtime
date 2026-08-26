import { createHash } from "node:crypto";

import { traceDebug } from "../../runtime/observability/debug-logger.js";
import type {
  ModelGatewayInputTokenCountParams,
  ModelGatewayInputTokenCountResult,
} from "../types.js";
import type { ModelGatewayClientOptions } from "./contracts.js";
import {
  buildChatGatewayRequestBody,
  resolveRequestMessages,
} from "./message-projection.js";
import { resolveClientOptions } from "./options.js";

const INPUT_TOKEN_COUNT_CACHE_MAX_ENTRIES = 64;

export type InputTokenCountCache = Map<
  string,
  ModelGatewayInputTokenCountResult
>;

function createInputTokenCountCacheKey(
  provider: string,
  requestBody: Readonly<Record<string, unknown>>,
): string {
  return createHash("sha256")
    .update(provider)
    .update("\0")
    .update(JSON.stringify(requestBody))
    .digest("hex");
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseInputTokenCountResult(
  value: unknown,
): ModelGatewayInputTokenCountResult {
  const body =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const inputTokens = body.inputTokens;
  const contextWindowTokens = body.contextWindowTokens;
  const profileId = body.profileId;
  const provider = body.provider;
  const model = body.model;
  const hasValidTokenCounts =
    isNonNegativeSafeInteger(inputTokens) &&
    isPositiveSafeInteger(contextWindowTokens);
  const hasValidModelBinding =
    isNonEmptyString(profileId) &&
    isNonEmptyString(provider) &&
    isNonEmptyString(model);
  const hasExpectedSource = body.source === "provider_input_token_count";
  const isValidResponse =
    hasValidTokenCounts && hasValidModelBinding && hasExpectedSource;
  if (!isValidResponse) {
    throw new Error("model_gateway_input_token_count_response_invalid");
  }
  return Object.freeze({
    inputTokens,
    contextWindowTokens,
    profileId,
    provider,
    model,
    source: "provider_input_token_count" as const,
  });
}

function updateInputTokenCountCache(
  cache: InputTokenCountCache | undefined,
  cacheKey: string,
  result: ModelGatewayInputTokenCountResult,
): void {
  if (!cache) {
    return;
  }

  cache.set(cacheKey, result);
  if (cache.size <= INPUT_TOKEN_COUNT_CACHE_MAX_ENTRIES) {
    return;
  }

  const oldestKey = cache.keys().next().value;
  if (typeof oldestKey === "string") {
    cache.delete(oldestKey);
  }
}

export async function countModelGatewayInputTokensWithOptions(
  params: ModelGatewayInputTokenCountParams,
  options: ModelGatewayClientOptions = {},
  cache?: InputTokenCountCache,
): Promise<ModelGatewayInputTokenCountResult | undefined> {
  const clientOptions = resolveClientOptions(options);
  const provider = params.provider.trim();
  if (!clientOptions.inputTokenCountProviders.has(provider)) {
    return undefined;
  }
  const requestMessages = resolveRequestMessages(params);
  const modelPolicy = params.modelPolicy ?? clientOptions.modelPolicy;
  const requestBody = buildChatGatewayRequestBody(
    params,
    requestMessages,
    modelPolicy,
  );
  const cacheKey = createInputTokenCountCacheKey(provider, requestBody);
  const cached = cache?.get(cacheKey);
  if (cached) {
    return cached;
  }
  const requestId = params.debugRequestId?.trim() ?? "";
  const startedAt = Date.now();
  traceDebug("model-gateway.client", "input_tokens.request.start", {
    requestId,
    url: `${clientOptions.baseUrl}/input-tokens`,
    provider,
    modelStep: params.modelStep,
    messageCount: requestMessages.length,
  });
  const response = await fetch(`${clientOptions.baseUrl}/input-tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    signal: params.abortSignal,
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `bridge_input_token_count_failed:${response.status}:${errorText || "empty error body"}`,
    );
  }
  const result = parseInputTokenCountResult(
    await response.json().catch(() => undefined),
  );
  if (result.provider !== provider) {
    throw new Error("model_gateway_input_token_count_provider_mismatch");
  }
  traceDebug("model-gateway.client", "input_tokens.request.completed", {
    requestId,
    provider: result.provider,
    profileId: result.profileId,
    model: result.model,
    inputTokens: result.inputTokens,
    durationMs: Date.now() - startedAt,
  });
  updateInputTokenCountCache(cache, cacheKey, result);
  return result;
}
