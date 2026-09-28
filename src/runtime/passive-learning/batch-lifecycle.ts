import { randomUUID } from "node:crypto";
import { PASSIVE_OBSERVATION_RETENTION_MS } from "../../shared/passive-observation.js";
import type { LearningBatch, LearningObservation } from "./contracts.js";

export function learningBatchExpiresAt(batch: LearningBatch): number {
  const collectedAt = batch.observations.map((item) =>
    Date.parse(item.timestamp),
  );
  return (
    Math.min(Date.parse(batch.createdAt), ...collectedAt) +
    PASSIVE_OBSERVATION_RETENTION_MS
  );
}

export function createPendingLearningBatch(
  observations: readonly LearningObservation[],
  generation: string,
  now: number,
): LearningBatch {
  return {
    id: randomUUID(),
    createdAt: new Date(now).toISOString(),
    generation,
    status: "pending",
    observations,
    recordIds: [],
  };
}

export function isPendingLearningBatch(batch: LearningBatch): boolean {
  return batch.status === "pending" || batch.status === "processing";
}

export function isDeferredLearningFailure(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  return ["learning_knowledge_conflict", "learning_outside_processing_window",
    "learning_receipt_capacity", "learning_memory_unavailable",
    "learning_review_progress_capacity", "learning_review_progress_storage_unavailable",
    "co_worker_model_daily_budget_exhausted", "co_worker_embedding_daily_budget_exhausted",
    "co_worker_embedding_character_budget_exhausted", "co_worker_resources_busy"].includes(error.message);
}

export function canResumeInterruptedLearning(
  signal: AbortSignal,
  current: boolean,
): boolean {
  if (!current || !signal.aborted || !(signal.reason instanceof Error))
    return false;
  return [
    "learning_interactive_preempted",
    "learning_processing_paused",
    "learning_stopped",
    "learning_application_processing_excluded",
  ].includes(signal.reason.message);
}

export function resolveLearningBatchFailureStatus(
  signal: AbortSignal,
  current: boolean,
  processingPersisted: boolean,
): LearningBatch["status"] {
  if (canResumeInterruptedLearning(signal, current)) return "pending";
  if (signal.aborted) return "cancelled";
  if (!processingPersisted && current) return "pending";
  return "failed";
}
