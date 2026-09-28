import type { LearningCandidateRecord, MaturationPolicy } from "./contracts.js";

export const DEFAULT_MATURATION_POLICY: MaturationPolicy = Object.freeze({
  promotionScore: 90,
  retentionDays: 30,
  maxCandidates: 500,
  maxBytes: 2 * 1024 * 1024,
});

export function validateMaturationPolicy(policy: MaturationPolicy): void {
  assertPolicyInteger(policy.promotionScore, 0, 100);
  assertPolicyInteger(policy.retentionDays, 1, 365);
  assertPolicyInteger(policy.maxCandidates, 1, 5000);
  assertPolicyInteger(policy.maxBytes, 1024, 20 * 1024 * 1024);
}

export function normalizeMaturationPolicy(policy: MaturationPolicy): MaturationPolicy {
  validateMaturationPolicy(policy);
  return Object.freeze({ ...policy });
}

export function isCandidateUnexpired(candidate: LearningCandidateRecord, now: number): boolean {
  return Date.parse(candidate.expiresAt) > now;
}

export function candidateRetentionDeadline(candidate: LearningCandidateRecord, policy: MaturationPolicy): number {
  return Math.min(Date.parse(candidate.expiresAt), Date.parse(candidate.lastReinforcedAt) + policy.retentionDays * 86_400_000);
}

/** Counts the full persisted record, including embedding and provenance. */
export function retainLearningCandidates(
  records: readonly LearningCandidateRecord[],
  policy: MaturationPolicy,
  now: number,
): readonly LearningCandidateRecord[] {
  validateMaturationPolicy(policy);
  const retained = records.filter((record) => candidateRetentionDeadline(record, policy) > now);
  const evictionOrder = [...retained].sort((a, b) =>
    a.score - b.score || a.lastReinforcedAt.localeCompare(b.lastReinforcedAt) || a.id.localeCompare(b.id),
  );
  const sizes = new Map(retained.map((record) => [record.id, Buffer.byteLength(JSON.stringify(record), "utf8") + 1]));
  let bytes = 2 + [...sizes.values()].reduce((sum, size) => sum + size, 0);
  const removed = new Set<string>();
  for (const record of evictionOrder) {
    if (retained.length - removed.size <= policy.maxCandidates && bytes <= policy.maxBytes) break;
    removed.add(record.id);
    bytes -= sizes.get(record.id)!;
  }
  return retained.filter((record) => !removed.has(record.id));
}

function assertPolicyInteger(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error("learning_maturation_policy_invalid");
}
