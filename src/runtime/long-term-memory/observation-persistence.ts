import type { LongTermMemoryRepository, LongTermMemoryRepositorySnapshot } from "./contracts.js";
import type { ObservationMemoryReceipt, SaveObservationMemoryInput } from "./observation-contracts.js";
import { bindObservationSource } from "./observation-source.js";
import { prepareMemoryCandidates } from "./candidate-preparation.js";
import { normalizeMemoryText } from "./policies/normalization.js";
import { containsSensitiveMemoryData } from "./policies/sensitive-data.js";
import { assertObservationBatchReplayable } from "./observation-receipt-retention.js";
import type { LearningKnowledgeContext, LearningMemoryDecision, LearningMemoryService } from "./maturation/contracts.js";
import { candidateKnowledge } from "./maturation/context.js";
import { MAX_LEARNING_DECISIONS } from "./maturation/decisions.js";
import { isCandidateUnexpired } from "./maturation/retention.js";

/** Legacy proposals have no quality assessment and enter the shared candidate gate. */
export async function saveObservationMemoryBatch(params: {
  repository: LongTermMemoryRepository;
  learning: LearningMemoryService;
  input: SaveObservationMemoryInput;
  now?: () => Date;
}): Promise<ObservationMemoryReceipt> {
  const { input, repository, learning } = params;
  const now = (params.now ?? (() => new Date()))().getTime();
  input.abortSignal.throwIfAborted();
  assertObservationBatchReplayable(input, now);
  const snapshot = await repository.read();
  const previous = snapshot.observationReceipts?.find((entry) => entry.batchId === input.batchId)
    ?? snapshot.learningReceipts?.find((entry) => entry.batchId === input.batchId);
  if (previous) return previous;
  const { decisions, context } = adaptObservationProposals(input, snapshot, now);
  return learning.apply({ ...input, decisions, context, policy: await learning.policy() });
}

function adaptObservationProposals(
  input: SaveObservationMemoryInput,
  snapshot: LongTermMemoryRepositorySnapshot,
  now: number,
): Readonly<{ decisions: readonly LearningMemoryDecision[]; context: LearningKnowledgeContext }> {
  const candidates = new Map((snapshot.learningCandidates ?? [])
    .filter((entry) => isCandidateUnexpired(entry, now))
    .map((entry) => [normalizeMemoryText(entry.content), entry]));
  // Existing stored memories cannot be changed by an unassessed legacy proposal.
  const seen = new Set(snapshot.records.map((entry) => normalizeMemoryText(entry.content)));
  const decisions: LearningMemoryDecision[] = [];
  const entries: LearningKnowledgeContext["entries"][number][] = [];
  for (const proposal of input.proposals) {
    if (decisions.length >= MAX_LEARNING_DECISIONS) break;
    if (!canPersistObservationReason(proposal.reason)) continue;
    const source = bindObservationSource(input, proposal);
    const candidate = prepareMemoryCandidates([proposal]).candidates[0];
    if (!candidate) continue;
    const key = normalizeMemoryText(candidate.content);
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = candidates.get(key);
    if (existing) entries.push(candidateKnowledge(existing));
    decisions.push({
      action: existing ? "update" : "create",
      targetKind: "candidate", targetId: existing?.id ?? null,
      targetVersion: existing ? String(existing.revision) : null,
      content: existing?.content ?? candidate.content,
      tags: existing?.tags ?? candidate.tags,
      score: existing?.score ?? 0,
      reason: existing?.reason ?? source.reason,
      certainty: existing?.certainty ?? source.certainty,
      observationIds: source.observationIds,
      reinforced: false, mergedCandidateIds: [],
      reconsiderAt: existing?.reconsiderAt ?? null,
    });
  }
  return {
    decisions,
    context: {
      kind: "learning_knowledge_reference_v1", authority: "passive_reference",
      presenceEffect: "does_not_authorize_actions_or_add_user_intent",
      repositoryRevision: snapshot.revision,
      knowledgeRevision: snapshot.knowledgeRevision ?? snapshot.revision,
      entries, omitted: 0, referenceTime: new Date(now).toISOString(),
    },
  };
}

function canPersistObservationReason(reason: string): boolean {
  if (!reason.trim()) return false;
  if (reason.length > 1_000) return false;
  return !containsSensitiveMemoryData(reason);
}
