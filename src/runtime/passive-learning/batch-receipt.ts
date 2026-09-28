import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { ObservationMemoryReceipt } from "../long-term-memory/observation-contracts.js";
import type { LearningBatch } from "./contracts.js";
import type { LearningActiveBatches } from "./active-batches.js";
import type { LearningJournal } from "./journal.js";
import { isPendingLearningBatch } from "./batch-lifecycle.js";
import { traceDebug } from "../observability/debug-logger.js";

export function resolveReviewedBatchStatus(records: readonly string[], candidates: readonly string[]): LearningBatch["status"] {
  if (records.length) return "saved";
  if (candidates.length) return "reviewed";
  return "discarded";
}

/** Receipts are commit authority across both the current and legacy memory stores. */
export async function readLearningBatchReceipt(memory: LongTermMemoryService, batchId: string): Promise<ObservationMemoryReceipt | undefined> {
  return await memory.learning?.receipt(batchId) ?? await memory.observationBatchReceipt?.(batchId);
}

/** Local bookkeeping must not depend on model budgets, windows, or app eligibility. */
export async function reconcileLearningBatchReceipts(options: {
  journal: LearningJournal; active: LearningActiveBatches; memory: LongTermMemoryService; generation(): string;
}): Promise<void> {
  const canReconcileBatch = (batch: LearningBatch): boolean => {
    if (!isPendingLearningBatch(batch) || options.active.has(batch.id)) return false;
    if (batch.generation !== options.generation()) return false;
    return options.journal.items.includes(batch);
  };
  for (const batch of options.journal.items) {
    if (!canReconcileBatch(batch)) continue;
    const receipt = await readLearningBatchReceipt(options.memory, batch.id);
    if (!receipt || !canReconcileBatch(batch)) continue;
    await options.journal.replace({ ...batch, status: resolveReviewedBatchStatus(receipt.recordIds, receipt.candidateIds ?? []),
      recordIds: receipt.recordIds, candidateIds: receipt.candidateIds ?? [], reason: undefined, completedAt: receipt.createdAt });
    traceDebug("runtime.passive_learning", "batch.receipt_reconciled", { batchId: batch.id,
      saved: receipt.recordIds.length, candidates: receipt.candidateIds?.length ?? 0 });
  }
}
