import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import { traceDebug } from "../observability/debug-logger.js";
import type { LearningBatch, PassiveLearningModel } from "./contracts.js";
import { learningFailureReason } from "./status-projection.js";
import { resolveReviewedBatchStatus } from "./batch-receipt.js";
import { reviewLearningBatch } from "./review-batch.js";
import { partitionOversizedLearningBatch } from "./batch-partition.js";
import {
  isDeferredLearningFailure,
  resolveLearningBatchFailureStatus,
} from "./batch-lifecycle.js";

export async function processLearningBatch(
  options: Readonly<{
    batch: LearningBatch;
    signal: AbortSignal;
    modelProfileId: string;
    model: PassiveLearningModel;
    memory: LongTermMemoryService;
    ownerId: string;
    isCurrent(): boolean;
    timestamp(): string;
    replace(batch: LearningBatch): Promise<void>;
    partition?(batches: readonly LearningBatch[]): Promise<boolean>;
    failed(error: unknown): void;
    succeeded?(): void;
  }>,
): Promise<void> {
  const { batch, signal } = options;
  let currentBatch = batch;
  const replace = async (next: LearningBatch): Promise<void> => {
    await options.replace(next);
    currentBatch = next;
  };
  const progress = {
    read: () => currentBatch.reviewProgress,
    save: async (reviewProgress: LearningBatch["reviewProgress"]): Promise<void> => {
      signal.throwIfAborted();
      if (!options.isCurrent()) throw new Error("learning_generation_superseded");
      try { await replace({ ...currentBatch, reviewProgress }); }
      catch (error) {
        if (error instanceof Error && ["learning_review_progress_capacity", "learning_batch_expired"].includes(error.message)) throw error;
        throw new Error("learning_review_progress_storage_unavailable");
      }
    },
  };
  let memoryCommitted = false;
  let processingPersisted = false;
  try {
    await replace({
      ...batch,
      status: "processing",
      reason: undefined,
      completedAt: undefined,
    });
    processingPersisted = true;
    signal.throwIfAborted();
    const receipt = await reviewLearningBatch({ ...options, progress });
    const candidateIds = receipt.candidateIds ?? [];
    memoryCommitted = true;
    await replace({
      ...currentBatch,
      reviewProgress: undefined,
      status: resolveReviewedBatchStatus(receipt.recordIds, candidateIds),
      reason: undefined,
      recordIds: receipt.recordIds,
      candidateIds,
      completedAt: options.timestamp(),
    });
    options.succeeded?.();
    traceDebug("runtime.passive_learning", "batch.completed", {
      batchId: batch.id,
      observations: batch.observations.length,
      saved: receipt.recordIds.length,
    });
  } catch (error) {
    if (memoryCommitted) {
      // The receipt is the commit authority; a journal failure cannot undo it.
      options.failed(error);
      traceDebug("runtime.passive_learning", "batch.journal_failed", {
        batchId: batch.id,
        reason: learningFailureReason(error),
      });
      return;
    }
    if (await partitionOversizedLearningBatch(error, { ...options, batch: currentBatch, replace })) return;
    const status = isDeferredLearningFailure(error) ? "pending" : resolveLearningBatchFailureStatus(
      signal,
      options.isCurrent(),
      processingPersisted,
    );
    const reason = learningFailureReason(error);
    if (!signal.aborted && options.isCurrent()) options.failed(error);
    await replace({
        ...currentBatch,
        reviewProgress: status === "pending" ? currentBatch.reviewProgress : undefined,
        status,
        reason,
        completedAt: status === "pending" ? undefined : options.timestamp(),
      })
      .catch(options.failed);
    traceDebug("runtime.passive_learning", "batch.failed", {
      batchId: batch.id,
      status,
      reason,
    });
  }
}
