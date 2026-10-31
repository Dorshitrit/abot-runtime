import type { ModelTokenUsage } from "../types.js";

function hasCompleteCacheAccounting(
  usage: ModelTokenUsage,
): usage is ModelTokenUsage & { cachedInputTokens: number; cacheWriteInputTokens: number } {
  if (usage.cachedInputTokens === undefined) return false;
  if (usage.cacheWriteInputTokens === undefined) return false;
  if (!Number.isSafeInteger(usage.inputTokens)) return false;
  if (!Number.isSafeInteger(usage.cachedInputTokens)) return false;
  if (!Number.isSafeInteger(usage.cacheWriteInputTokens)) return false;
  if (usage.cachedInputTokens < 0) return false;
  if (usage.cacheWriteInputTokens < 0) return false;
  return usage.cacheWriteInputTokens <= usage.inputTokens - usage.cachedInputTokens;
}

/** Uncached remains the legacy non-read total; ordinary excludes cache writes. */
export function buildCacheUsageMetrics(usage?: ModelTokenUsage): Record<string, unknown> {
  if (!usage) return {};
  return {
    ...(usage.cachedInputTokens !== undefined
      ? {
          cachedInputTokens: usage.cachedInputTokens,
          uncachedInputTokens: usage.inputTokens - usage.cachedInputTokens,
        }
      : {}),
    ...(usage.cacheWriteInputTokens !== undefined
      ? { cacheWriteInputTokens: usage.cacheWriteInputTokens }
      : {}),
    ...(usage.cacheWriteInputTokensDetails
      ? { cacheWriteInputTokensDetails: usage.cacheWriteInputTokensDetails }
      : {}),
    ...(hasCompleteCacheAccounting(usage)
      ? {
          ordinaryInputTokens:
            usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens,
        }
      : {}),
  };
}
