import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { LearningBatch, PassiveLearningModel } from "./contracts.js";
import { learningBatchExpiresAt } from "./batch-lifecycle.js";
import { traceDebug } from "../observability/debug-logger.js";
import { learningFailureReason } from "./status-projection.js";
import { readLearningBatchReceipt } from "./batch-receipt.js";
import type { ReviewProgressPort } from "./review-progress.js";

/** Model choice and memory commit are separate; only a durable receipt is success. */
export async function reviewLearningBatch(options: {
  batch: LearningBatch; model: PassiveLearningModel; memory: LongTermMemoryService;
  modelProfileId: string; signal: AbortSignal; ownerId: string;
  isCurrent(): boolean;
  progress?: ReviewProgressPort;
}) {
  const { batch, model, memory, signal } = options;
  const input = { batchId: batch.id, environmentId: options.ownerId,
    batchExpiresAt: new Date(learningBatchExpiresAt(batch)).toISOString(),
    observations: batch.observations, abortSignal: signal };
  if (memory.learning && model.review) {
    let stage = "receipt";
    try {
      const previous = await readLearningBatchReceipt(memory, batch.id);
      if (previous) return previous;
      stage = "admission";
      if (typeof memory.learning.reviewAdmission === "function") {
        const admission = await memory.learning.reviewAdmission();
        if (!admission.available) throw new Error("learning_receipt_capacity");
      }
      stage = "context";
      const startedAt = performance.now();
      const query = batch.observations.map((observation) => JSON.stringify(observation)).join("\n").slice(0, 8000);
      const context = await memory.learning.prepare({ query, abortSignal: signal, debugRequestId: `learning:${batch.id}` });
      traceDebug("runtime.passive_learning", "review.context_prepared", {
        requestId: `learning:${batch.id}`, batchId: batch.id,
        durationMs: Math.round(performance.now() - startedAt),
        observationCount: batch.observations.length, knowledgeCount: context.entries.length, omitted: context.omitted,
      });
      const policy = await memory.learning.policy();
      stage = "model";
      const decisions = await model.review({ batchId: batch.id, observations: batch.observations,
        modelProfileId: options.modelProfileId, signal, context, promotionScore: policy.promotionScore,
        progress: options.progress, expiresAt: input.batchExpiresAt });
      signal.throwIfAborted();
      if (!options.isCurrent()) throw new Error("learning_generation_superseded");
      stage = "apply";
      return await memory.learning.apply({ ...input, context, decisions, policy });
    } catch (error) {
      traceDebug("runtime.passive_learning", "review.failed", {
        requestId: `learning:${batch.id}`, batchId: batch.id, stage, reason: learningFailureReason(error),
      });
      throw error;
    }
  }
  const proposals = await model.extract({ batchId: batch.id, observations: batch.observations,
    modelProfileId: options.modelProfileId, signal });
  signal.throwIfAborted();
  if (!options.isCurrent()) throw new Error("learning_generation_superseded");
  return memory.saveObservationBatch!({ ...input, proposals });
}
