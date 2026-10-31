import type { ModelTokenUsage } from "../types.js";

function isCacheTokenCount(value: unknown): value is number {
  if (typeof value !== "number") return false;
  if (!Number.isSafeInteger(value)) return false;
  return value >= 0;
}

function readCacheWriteDetails(
  value: unknown,
  cacheWriteInputTokens: number,
): ModelTokenUsage["cacheWriteInputTokensDetails"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const details = value as Record<string, unknown>;
  const { ttl30mTokens, ttl12hTokens } = details;
  if (!isCacheTokenCount(ttl30mTokens)) return undefined;
  if (!isCacheTokenCount(ttl12hTokens)) return undefined;
  if (ttl30mTokens + ttl12hTokens !== cacheWriteInputTokens) return undefined;
  return { ttl30mTokens, ttl12hTokens };
}

/** Preserve optional provider accounting without inventing missing cache counts. */
export function normalizeCacheWriteUsage(params: {
  inputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: unknown;
  cacheWriteInputTokensDetails?: unknown;
}): Pick<ModelTokenUsage, "cacheWriteInputTokens" | "cacheWriteInputTokensDetails"> {
  const cacheWriteInputTokens = params.cacheWriteInputTokens;
  if (!isCacheTokenCount(cacheWriteInputTokens)) return {};
  const nonReadInputTokens = params.inputTokens - (params.cachedInputTokens ?? 0);
  if (cacheWriteInputTokens > nonReadInputTokens) return {};
  const cacheWriteInputTokensDetails = readCacheWriteDetails(
    params.cacheWriteInputTokensDetails,
    cacheWriteInputTokens,
  );
  return {
    cacheWriteInputTokens,
    ...(cacheWriteInputTokensDetails ? { cacheWriteInputTokensDetails } : {}),
  };
}
