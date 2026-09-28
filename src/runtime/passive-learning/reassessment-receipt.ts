import type { LearningMemoryService } from "../long-term-memory/maturation/contracts.js";
import type { createReassessmentStateStore } from "./reassessment-state.js";
import { traceDebug } from "../observability/debug-logger.js";

/** Finish local bookkeeping for a committed review without repeating inference. */
export async function reconcileCommittedReassessment(
  store: ReturnType<typeof createReassessmentStateStore>, memory: LearningMemoryService,
) {
  const state = await store.read();
  if (!state.fingerprint) return state;
  const batchId = `reassess-${state.fingerprint}`;
  if (!await memory.receipt(batchId)) return state;
  const current = await memory.sourceVersions();
  // Memory commits consume every scheduled trigger, including no-change reviews.
  // Retain unrelated failed bindings whose exact version is still current.
  const isCurrentReassessmentBinding = (binding: typeof state.blockedEntries[number]) => current.some((entry) =>
    entry.kind === binding.kind && entry.id === binding.id && entry.version === binding.version);
  const completed = state.blockedEntries.filter((binding) => !isCurrentReassessmentBinding(binding));
  await store.complete(state.fingerprint, completed);
  traceDebug("runtime.passive_learning", "reassessment.receipt_reconciled", { batchId, completed: completed.length });
  return store.read();
}
