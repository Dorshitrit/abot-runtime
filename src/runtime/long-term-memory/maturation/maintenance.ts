import type { LongTermMemoryRepository, LongTermMemoryRepositorySnapshot } from "../contracts.js";
import type { LearningMemoryMaintenance, MaturationPolicy } from "./contracts.js";
import { candidateRetentionDeadline, retainLearningCandidates, validateMaturationPolicy } from "./retention.js";

/** Call at an actual expiry/configuration change, not on a frequent polling loop. */
export async function maintainLearningMemory(
  repository: LongTermMemoryRepository,
  policy: MaturationPolicy,
  now: number,
): Promise<LearningMemoryMaintenance> {
  validateMaturationPolicy(policy);
  const initial = await repository.read();
  const planned = retentionState(initial, policy, now);
  if (!hasLearningRetentionChanges(planned.result)) return planned.result;
  let result = planned.result;
  await repository.update((current) => {
    const retained = retentionState(current, current.maturationPolicy ?? policy, now);
    result = retained.result;
    return { ...current, learningCandidates: retained.candidates, learningReceipts: retained.receipts };
  });
  return result;
}

export function nextLearningExpiryAt(
  snapshot: LongTermMemoryRepositorySnapshot,
  policy: MaturationPolicy,
): string | null {
  validateMaturationPolicy(policy);
  let earliest = Infinity;
  for (const candidate of snapshot.learningCandidates ?? [])
    earliest = Math.min(earliest, candidateRetentionDeadline(candidate, policy));
  for (const receipt of snapshot.learningReceipts ?? [])
    earliest = Math.min(earliest, Date.parse(receipt.expiresAt));
  return Number.isFinite(earliest) ? new Date(earliest).toISOString() : null;
}

function retentionState(snapshot: LongTermMemoryRepositorySnapshot, policy: MaturationPolicy, now: number) {
  const candidates = retainLearningCandidates(snapshot.learningCandidates ?? [], policy, now);
  const receipts = (snapshot.learningReceipts ?? []).filter((receipt) => Date.parse(receipt.expiresAt) > now);
  const result: LearningMemoryMaintenance = {
    removedCandidateCount: (snapshot.learningCandidates?.length ?? 0) - candidates.length,
    removedReceiptCount: (snapshot.learningReceipts?.length ?? 0) - receipts.length,
    nextExpiryAt: nextLearningExpiryAt({ ...snapshot, learningCandidates: candidates, learningReceipts: receipts }, policy),
  };
  return { candidates, receipts, result };
}

function hasLearningRetentionChanges(result: LearningMemoryMaintenance): boolean {
  if (result.removedCandidateCount > 0) return true;
  return result.removedReceiptCount > 0;
}
