import type { ModelTokenUsage } from "../types.js";
import { normalizeCacheWriteUsage } from "./cache-write-usage.js";

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

export function buildModelTokenUsage(params: {
  inputTokens: unknown;
  outputTokens: unknown;
  totalTokens?: unknown;
  cachedInputTokens?: unknown;
  cacheWriteInputTokens?: unknown;
  cacheWriteInputTokensDetails?: unknown;
  reasoningTokens?: unknown;
}): ModelTokenUsage | undefined {
  const inputTokens = readNonNegativeInteger(params.inputTokens);
  const outputTokens = readNonNegativeInteger(params.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }

  const reportedTotal = readNonNegativeInteger(params.totalTokens);
  const cachedInputTokens = readNonNegativeInteger(params.cachedInputTokens);
  const reasoningTokens = readNonNegativeInteger(params.reasoningTokens);

  const usage: ModelTokenUsage = {
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal ?? inputTokens + outputTokens,
    ...(cachedInputTokens !== undefined && cachedInputTokens <= inputTokens
      ? { cachedInputTokens }
      : {}),
    ...(reasoningTokens !== undefined && reasoningTokens <= outputTokens
      ? { reasoningTokens }
      : {}),
  };
  return {
    ...usage,
    ...normalizeCacheWriteUsage({
      inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: params.cacheWriteInputTokens,
      cacheWriteInputTokensDetails: params.cacheWriteInputTokensDetails,
    }),
  };
}

export function normalizeModelTokenUsage(
  value: unknown,
): ModelTokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  return buildModelTokenUsage({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    cacheWriteInputTokensDetails: usage.cacheWriteInputTokensDetails,
    reasoningTokens: usage.reasoningTokens,
  });
}
