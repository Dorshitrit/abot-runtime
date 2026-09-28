import { isDeepStrictEqual } from "node:util";
import type { LongTermMemoryRepositorySnapshot } from "../contracts.js";
import type { ApplyLearningDecisionsInput, LearningKnowledgeEntry } from "./contracts.js";
import { candidateKnowledge, memoryKnowledge } from "./context.js";
import { assertLearningDecisionBindings } from "./decisions.js";
import { isCandidateUnexpired } from "./retention.js";
import { isScheduledKnowledgeReview } from "./scheduled-review.js";
import { assertDistinctLearningMemoryWriteTargets } from "./write-targets.js";

/** Supplied context is evidence, never authority to recreate or rewrite a target. */
export function assertCurrentLearningDecisionBindings(
  current: LongTermMemoryRepositorySnapshot,
  input: ApplyLearningDecisionsInput,
  now: number,
): void {
  // Unrelated batches may commit concurrently; only decision targets and merge
  // sources are compare-and-swap dependencies, not the whole repository revision.
  assertLearningDecisionBindings(input.decisions, input.context, input.observations.map(({ id }) => id), now, input.cause);
  for (const decision of input.decisions) {
    if (decision.action !== "create")
      assertCurrentEntry(current, input, decision.targetKind, decision.targetId!, now);
    for (const id of decision.mergedCandidateIds)
      assertCurrentEntry(current, input, "candidate", id, now);
  }
  assertDistinctLearningMemoryWriteTargets(current, input.decisions);
  if (!isScheduledKnowledgeReview(input.cause)) return;
  if (input.observations.length) throw new Error("learning_review_observations_unexpected");
  for (const due of input.cause.dueEntries) {
    assertCurrentEntry(current, input, due.kind, due.id, now);
    const entry = currentEntry(current, due.kind, due.id, now);
    if (entry.version !== due.version) throw new Error("learning_knowledge_conflict");
    if (!entry.reconsiderAt || Date.parse(entry.reconsiderAt) > now) throw new Error("learning_review_target_not_due");
  }
}

function assertCurrentEntry(
  current: LongTermMemoryRepositorySnapshot,
  input: ApplyLearningDecisionsInput,
  kind: LearningKnowledgeEntry["kind"],
  id: string,
  now: number,
): void {
  const supplied = input.context.entries.find((entry) => entry.kind === kind && entry.id === id);
  const canonical = currentEntry(current, kind, id, now);
  if (!isDeepStrictEqual(supplied, canonical)) throw new Error("learning_knowledge_conflict");
  if (!canonical.mutable) throw new Error("learning_memory_protected");
}

function currentEntry(
  current: LongTermMemoryRepositorySnapshot,
  kind: LearningKnowledgeEntry["kind"],
  id: string,
  now: number,
): LearningKnowledgeEntry {
  if (kind === "memory") {
    const target = current.records.find((record) => record.id === id);
    if (!target) throw new Error("learning_decision_target_unknown");
    return memoryKnowledge(target);
  }
  const target = current.learningCandidates?.find((record) => record.id === id);
  if (!target) throw new Error("learning_decision_target_unknown");
  if (!isCandidateUnexpired(target, now)) throw new Error("learning_candidate_expired");
  return candidateKnowledge(target);
}
