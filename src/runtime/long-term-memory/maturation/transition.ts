import type { LongTermMemoryRecord, LongTermMemoryRepositorySnapshot, LongTermMemoryRepositoryState, MemoryVectorIndexEntry } from "../contracts.js";
import { canAutomaticallyManageMemory } from "../automatic-management.js";
import { normalizeMemoryText } from "../policies/normalization.js";
import type { ObservationMemorySource } from "../observation-contracts.js";
import { assertObservationBatchReplayable, retainReplayableObservationReceipts } from "../observation-receipt-retention.js";
import type { ApplyLearningDecisionsInput, LearningCandidateRecord, LearningMemoryDecision, LearningMemoryReceipt } from "./contracts.js";
import { isCandidateUnexpired, retainLearningCandidates, normalizeMaturationPolicy } from "./retention.js";
import { assertCurrentLearningDecisionBindings } from "./current-bindings.js";
import { assertCompatibleLearningEmbeddings, currentLearningEmbeddingBinding } from "./embedding-binding.js";
import { mergeLearningSources } from "./sources.js";
import { normalizeLearningDecisions } from "./decisions.js";
import { consumeScheduledReviewTriggers } from "./scheduled-review.js";
import { assertLearningReceiptCapacity } from "./receipt-capacity.js";
import { canPromoteLearningCandidate, hasFreshCandidateReinforcement } from "./candidate-promotion.js";
import { advanceLearningReinforcements, bindLearningMemorySource } from "./evidence.js";
import { canCommitLearningReplacement, prepareLearningMemoryUpdate, updateMemoryReviewDeadline } from "./memory-update.js";

export function commitLearningDecisions(options: {
  current: LongTermMemoryRepositorySnapshot;
  input: ApplyLearningDecisionsInput;
  embeddings: ReadonlyMap<string, Omit<MemoryVectorIndexEntry, "memoryId">>;
  now: number;
}): { state: LongTermMemoryRepositoryState; receipt: LearningMemoryReceipt } {
  const { current, now } = options;
  const input = { ...options.input, policy: normalizeMaturationPolicy(current.maturationPolicy ?? options.input.policy), decisions: normalizeLearningDecisions(options.input.decisions) };
  assertObservationBatchReplayable(input, now);
  const previous = current.learningReceipts?.find((receipt) => receipt.batchId === input.batchId);
  if (previous) return { state: current, receipt: previous };
  assertCurrentLearningDecisionBindings(current, input, now);
  assertCompatibleLearningEmbeddings(options.embeddings.values(), currentLearningEmbeddingBinding(current, now));
  const records = new Map(current.records.map((record) => [record.id, record]));
  const vectors = new Map(current.vectors.map((vector) => [vector.memoryId, vector]));
  const candidates = new Map((current.learningCandidates ?? []).filter((record) => isCandidateUnexpired(record, now)).map((record) => [record.id, record]));
  const recordIds = new Set<string>();
  const candidateIds = new Set<string>();
  for (const decision of input.decisions) {
    if (decision.action === "remove") {
      removeTarget(decision, candidates, records, vectors);
      continue;
    }
    const update = prepareLearningMemoryUpdate(decision, records, candidates);
    const { id, previous: target } = update;
    const source = bindLearningMemorySource(input, decision);
    if (update.unchanged) {
      records.set(id, updateMemoryReviewDeadline(update.unchanged, decision.reconsiderAt, candidates, now));
      recordIds.add(id);
      continue;
    }
    assertNoExactDuplicate(decision.content, id, candidates, records, [...decision.mergedCandidateIds, ...(update.replacement ? [update.replacement.id] : [])]);
    const mergedSources = decision.mergedCandidateIds.flatMap((merged) => candidates.get(merged)!.sources);
    for (const merged of decision.mergedCandidateIds) candidates.delete(merged);
    if (records.has(id)) throw new Error("learning_candidate_identity_conflict");
    const existingVector = decision.targetKind === "memory" && records.get(decision.targetId!)?.content === decision.content
      ? vectors.get(decision.targetId!) : undefined;
    const vector = resolveCandidateVector(id, decision.content, target, options.embeddings, existingVector);
    const reinforced = hasFreshCandidateReinforcement({ previous: target, decision, input, source, mergedSources });
    const lastReinforcedAt = resolveReinforcementTime(target, reinforced, now);
    const candidate: LearningCandidateRecord = {
      id, revision: (target?.revision ?? 0) + 1, content: decision.content, tags: decision.tags,
      score: decision.score, reason: decision.reason, certainty: decision.certainty,
      sources: source ? mergeLearningSources([...(target?.sources ?? []), ...mergedSources, source]) : target?.sources ?? [],
      reinforcements: advanceLearningReinforcements(target?.reinforcements, source, reinforced, now),
      ...(update.replacement ? { replacement: update.replacement } : {}),
      createdAt: target?.createdAt ?? new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
      lastReinforcedAt, expiresAt: new Date(Date.parse(lastReinforcedAt) + input.policy.retentionDays * 86_400_000).toISOString(),
      reconsiderAt: decision.reconsiderAt, embedding: vector,
    };
    if (!canPromoteLearningCandidate(target, decision, input, reinforced, candidate.reinforcements) || !canCommitLearningReplacement(candidate, records)) {
      candidates.set(id, candidate);
      candidateIds.add(id);
      continue;
    }
    const memoryId = candidate.replacement?.id ?? id;
    const replaced = records.get(memoryId);
    records.set(memoryId, { id: memoryId, content: candidate.content, tags: candidate.tags, provenance: source!,
      automaticManagement: "allowed", observationSources: candidate.sources.filter((entry): entry is ObservationMemorySource => entry.kind === "passive_observation"), reconsiderAt: candidate.reconsiderAt,
      createdAt: replaced?.createdAt ?? new Date(now).toISOString(), updatedAt: nextVersionTime(replaced?.updatedAt ?? candidate.createdAt, now) });
    vectors.set(memoryId, { ...vector, memoryId });
    candidates.delete(id);
    recordIds.add(memoryId);
  }
  consumeScheduledReviewTriggers(input, candidates, records, now);
  const retained = retainLearningCandidates([...candidates.values()], input.policy, now);
  const retainedIds = new Set(retained.map(({ id }) => id));
  const receipt: LearningMemoryReceipt = Object.freeze({
    batchId: input.batchId, recordIds: [...recordIds], candidateIds: [...candidateIds].filter((id) => retainedIds.has(id)),
    removedCandidateCount: candidates.size - retained.length,
    createdAt: new Date(now).toISOString(), expiresAt: input.batchExpiresAt,
  });
  assertLearningReceiptCapacity(current.learningReceipts ?? [], receipt, now);
  return {
    state: { records: [...records.values()], vectors: [...vectors.values()], learningCandidates: retained,
      maturationPolicy: input.policy,
      observationReceipts: retainReplayableObservationReceipts(current.observationReceipts ?? [], now),
      learningReceipts: [...(current.learningReceipts ?? []).filter((entry) => Date.parse(entry.expiresAt) > now), receipt] },
    receipt,
  };
}

function removeTarget(decision: LearningMemoryDecision, candidates: Map<string, LearningCandidateRecord>, records: Map<string, LongTermMemoryRecord>, vectors: Map<string, MemoryVectorIndexEntry>): void {
  const id = decision.targetId!;
  if (decision.targetKind === "candidate") { candidates.delete(id); return; }
  const record = records.get(id);
  if (!record || !canAutomaticallyManageMemory(record)) throw new Error("learning_memory_protected");
  records.delete(id);
  vectors.delete(id);
}
function assertNoExactDuplicate(content: string, targetId: string, candidates: Map<string, LearningCandidateRecord>, records: Map<string, LongTermMemoryRecord>, mergedIds: readonly string[]): void {
  const key = normalizeMemoryText(content);
  const duplicate = [...candidates.values(), ...records.values()].some((record) =>
    record.id !== targetId && !mergedIds.includes(record.id) && normalizeMemoryText(record.content) === key,
  );
  if (duplicate) throw new Error("learning_duplicate_requires_bound_update");
}
function resolveCandidateVector(id: string, content: string, target: LearningCandidateRecord | undefined, embeddings: ReadonlyMap<string, Omit<MemoryVectorIndexEntry, "memoryId">>, existing?: MemoryVectorIndexEntry): MemoryVectorIndexEntry {
  if (target?.content === content) return target.embedding;
  const vector = embeddings.get(content) ?? existing;
  if (!vector) throw new Error("learning_candidate_embedding_missing");
  return { ...vector, memoryId: id };
}
function resolveReinforcementTime(target: LearningCandidateRecord | undefined, reinforced: boolean, now: number): string {
  if (target && !reinforced) return target.lastReinforcedAt;
  return new Date(now).toISOString();
}
function nextVersionTime(previous: string, now: number): string {
  return new Date(Math.max(now, Date.parse(previous) + 1)).toISOString();
}
