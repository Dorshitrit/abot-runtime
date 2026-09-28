import { traceDebug } from "../observability/debug-logger.js";
import { createPendingLearningBatch } from "./batch-lifecycle.js";
import type { LearningBatch } from "./contracts.js";
import { LearningReviewCapacityError } from "./review-capacity.js";
import { learningFailureReason } from "./status-projection.js";

/** Keep whole observations durable; each part gets a fresh bound knowledge review. */
export async function partitionOversizedLearningBatch(error: unknown, options: {
  batch: LearningBatch;
  signal: AbortSignal;
  isCurrent(): boolean;
  partition?(batches: readonly LearningBatch[]): Promise<boolean>;
  replace(batch: LearningBatch): Promise<void>;
  failed(error: unknown): void;
}): Promise<boolean> {
  if (!(error instanceof LearningReviewCapacityError)) return false;
  if (options.batch.observations.length < 2 || !options.partition) return false;
  if (options.signal.aborted || !options.isCurrent()) return false;
  const parts = partitionLearningObservations(options.batch);
  try {
    if (!await options.partition(parts)) {
      await options.replace({ ...options.batch, status: "pending", reason: undefined, completedAt: undefined });
      options.failed(new Error("learning_partition_capacity"));
      traceDebug("runtime.passive_learning", "batch.partition_deferred", { batchId: options.batch.id });
      return true;
    }
  } catch (storageError) {
    // Do not overwrite a partially staged journal partition with the original batch.
    options.failed(storageError);
    traceDebug("runtime.passive_learning", "batch.partition_failed", {
      batchId: options.batch.id, reason: learningFailureReason(storageError),
    });
    return true;
  }
  traceDebug("runtime.passive_learning", "batch.partitioned", {
    batchId: options.batch.id,
    parts: parts.map(({ id, observations }) => ({ batchId: id, observations: observations.length })),
    reason: "learning_review_context_exceeds_budget",
  });
  return true;
}

function partitionLearningObservations(batch: LearningBatch): readonly LearningBatch[] {
  const middle = Math.ceil(batch.observations.length / 2);
  const createdAt = Date.parse(batch.createdAt);
  const first = createPendingLearningBatch(batch.observations.slice(0, middle), batch.generation, createdAt);
  const second = createPendingLearningBatch(batch.observations.slice(middle), batch.generation, createdAt);
  return [
    { ...first, id: batch.id, reason: "learning_batch_partitioned" },
    { ...second, reason: "learning_batch_partitioned" },
  ];
}
