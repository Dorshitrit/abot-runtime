import type { LongTermMemoryRepositorySnapshot } from "../contracts.js";
import type { LearningCandidateRecord, LearningMemoryDecision } from "./contracts.js";

/** Candidate promotion and an explicit memory decision must not write the same record. */
export function assertDistinctLearningMemoryWriteTargets(
  current: LongTermMemoryRepositorySnapshot,
  decisions: readonly LearningMemoryDecision[],
): void {
  const candidates = new Map((current.learningCandidates ?? []).map((candidate) => [candidate.id, candidate]));
  const memoryTargets = new Set<string>();
  for (const decision of decisions) {
    const id = resolveLearningMemoryWriteTarget(decision, candidates);
    if (!id) continue;
    if (memoryTargets.has(id)) throw new Error("learning_decision_target_repeated");
    memoryTargets.add(id);
  }
}

function resolveLearningMemoryWriteTarget(
  decision: LearningMemoryDecision,
  candidates: ReadonlyMap<string, LearningCandidateRecord>,
): string | undefined {
  if (decision.action === "create") return undefined;
  if (decision.targetKind === "memory") return decision.targetId!;
  if (decision.action === "remove") return undefined;
  return candidates.get(decision.targetId!)?.replacement?.id;
}
