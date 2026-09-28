import type { PassiveLearningPreferences } from "./contracts.js";
import type { LearningBackgroundDependencies } from "./background-dependencies.js";
import { DEFAULT_CO_WORKER_RESOURCE_LIMITS, type CoWorkerResourceUsage } from "./resources/contracts.js";

export type LearningBudgetDeferral = Readonly<{ until: number; reason: string }>;
/** Modern reviews can embed both the retrieval query and the accepted changes. */
export function learningBatchEmbeddingCalls(background: LearningBackgroundDependencies): number {
  if (background.memory.learning && background.model.review) return 2;
  return 1;
}
export function isLearningDailyBudgetFailure(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  return ["co_worker_model_daily_budget_exhausted", "co_worker_embedding_daily_budget_exhausted",
    "co_worker_embedding_character_budget_exhausted"].includes(error.message);
}
export function learningBudgetDeferral(
  usage: CoWorkerResourceUsage | undefined, preferences: PassiveLearningPreferences,
  embeddingCallsPerBatch = 1,
): LearningBudgetDeferral | undefined {
  if (!usage) return undefined;
  const limits = preferences.resourceLimits ?? DEFAULT_CO_WORKER_RESOURCE_LIMITS;
  if (usage.modelCalls >= limits.modelCallsPerDay)
    return { until: usage.resetsAt, reason: "co_worker_model_daily_budget_exhausted" };
  if (limits.embeddingCallsPerDay - usage.embeddingCalls < embeddingCallsPerBatch)
    return { until: usage.resetsAt, reason: "co_worker_embedding_daily_budget_exhausted" };
  if (usage.embeddingCharacters >= limits.embeddingCharactersPerDay)
    return { until: usage.resetsAt, reason: "co_worker_embedding_character_budget_exhausted" };
  return undefined;
}
export function availableLearningBatchSlots(
  usage: (CoWorkerResourceUsage & { activeCalls: number }) | undefined,
  preferences: PassiveLearningPreferences, available: number,
  embeddingCallsPerBatch = 1,
): number {
  if (!usage) return available;
  const limits = preferences.resourceLimits ?? DEFAULT_CO_WORKER_RESOURCE_LIMITS;
  const maximum = preferences.maxConcurrentBatches ?? limits.maxConcurrentCalls;
  const embeddingSlots = Math.floor((limits.embeddingCallsPerDay - usage.embeddingCalls) / embeddingCallsPerBatch);
  return Math.max(0, Math.min(available, maximum - usage.activeCalls,
    limits.modelCallsPerDay - usage.modelCalls, embeddingSlots));
}
