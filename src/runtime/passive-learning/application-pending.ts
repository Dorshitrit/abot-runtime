import type { LearningActiveBatches } from "./active-batches.js";
import { canProcessLearningBatch, canProcessLearningObservation } from "./application-policy.js";
import { createPendingLearningBatch } from "./batch-lifecycle.js";
import type { LearningBatch, LearningObservation, PassiveLearningPreferences } from "./contracts.js";
import type { LearningJournal } from "./journal.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import { readLearningBatchReceipt, resolveReviewedBatchStatus } from "./batch-receipt.js";

export function hasProcessablePendingBatch(
  batch: LearningBatch, generation: string, active: LearningActiveBatches, preferences: PassiveLearningPreferences,
  eligible: (item: LearningObservation) => boolean = () => true,
): boolean {
  if (batch.status !== "pending" || batch.generation !== generation || active.has(batch.id)) return false;
  return batch.observations.some((item) => canProcessLearningObservation(item, preferences) && eligible(item));
}

/** Split only uncommitted mixed batches; held evidence keeps its original expiry. */
export async function prepareApplicationPendingBatch(options: {
  journal: LearningJournal;
  active: LearningActiveBatches;
  memory: LongTermMemoryService;
  generation(): string;
  preferences(): PassiveLearningPreferences;
  canProcess(): boolean;
  eligible?(item: LearningObservation): boolean;
}): Promise<LearningBatch | undefined> {
  const eligible = (item: LearningObservation) => {
    if (!canProcessLearningObservation(item, options.preferences())) return false;
    return options.eligible?.(item) ?? true;
  };
  for (const batch of options.journal.items) {
    if (!hasProcessablePendingBatch(batch, options.generation(), options.active, options.preferences(), eligible)) continue;
    if (batch.observations.every(eligible)) return batch;
    const receipt = await readLearningBatchReceipt(options.memory, batch.id);
    if (!options.canProcess() || batch.generation !== options.generation()) return undefined;
    if (receipt) {
      await options.journal.replace({ ...batch, status: resolveReviewedBatchStatus(receipt.recordIds, receipt.candidateIds ?? []),
        recordIds: receipt.recordIds, candidateIds: receipt.candidateIds ?? [], reason: undefined, completedAt: receipt.createdAt });
      continue;
    }
    const preferences = options.preferences();
    const allowed = batch.observations.filter(eligible);
    if (!allowed.length) continue;
    if (allowed.length === batch.observations.length) return batch;
    const held = batch.observations.filter((item) => !eligible(item));
    const ready: LearningBatch = { ...batch, observations: allowed, reason: undefined, reviewProgress: undefined };
    const blocked = { ...createPendingLearningBatch(held, batch.generation, Date.parse(batch.createdAt)),
      reason: canProcessLearningBatch(batch, preferences) ? undefined : "learning_application_processing_excluded" };
    if (!await options.journal.partition([ready, blocked])) throw new Error("learning_partition_capacity");
    return ready;
  }
  return undefined;
}
