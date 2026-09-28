import type {
  LongTermMemoryRepository,
  LongTermMemoryRequestContext,
  MemoryCandidate,
  MemoryCandidateProcessingResult,
} from "./contracts.js";
import {
  classifyMemoryFailure,
  traceLongTermMemoryOperation,
} from "./diagnostics.js";
import { prepareMemoryCandidates } from "./candidate-preparation.js";
import { canAutomaticallyManageMemory } from "./automatic-management.js";
import type { LongTermMemoryManagementService } from "./management/contracts.js";
import type { LearningMemoryService } from "./maturation/contracts.js";
import { assertConversationReviewCause } from "./maturation/conversation-evidence.js";
import { MAX_LEARNING_DECISIONS } from "./maturation/decisions.js";
import { conversationMemoryBatchId, prepareConversationDecisions } from "./conversation-candidates.js";
import { mergeMemoryTags, normalizeMemoryText } from "./policies/normalization.js";

export async function processMemoryCandidates(params: {
  repository: LongTermMemoryRepository;
  learning: LearningMemoryService;
  management: Pick<LongTermMemoryManagementService, "create" | "update">;
  candidates: readonly MemoryCandidate[];
  context: LongTermMemoryRequestContext;
  now?: () => Date;
}): Promise<MemoryCandidateProcessingResult> {
  const startedAt = Date.now();
  let acceptedCount = 0;
  let duplicateCount = 0;
  try {
    params.context.abortSignal.throwIfAborted();
    const prepared = prepareMemoryCandidates(params.candidates.slice(0, MAX_LEARNING_DECISIONS));
    const overflow = Math.max(0, params.candidates.length - MAX_LEARNING_DECISIONS);
    if (prepared.candidates.length === 0) {
      return completeCandidateProcessing(params, startedAt, {
        proposedCount: params.candidates.length,
        acceptedCount: 0,
        rejectedCount: prepared.rejectedCount + overflow,
        duplicateCount: prepared.duplicateCount,
      });
    }
    const snapshot = await params.repository.read();
    const now = (params.now ?? (() => new Date()))().getTime();
    const allReview = prepareConversationDecisions({ candidates: prepared.candidates, snapshot, context: params.context, now });
    assertConversationReviewCause({ kind: "conversation_memory_review", evidence: allReview.evidence }, now);
    const explicit = prepared.candidates.filter((candidate) => candidate.assessment?.explicitlyRequested === true);
    for (const candidate of explicit) {
      const saved = await saveExplicitlyRequestedMemory(params, candidate);
      if (saved) acceptedCount += 1;
      else duplicateCount += 1;
    }
    const automatic = prepared.candidates.filter((candidate) => candidate.assessment?.explicitlyRequested !== true);
    if (automatic.length > 0) {
      const review = prepareConversationDecisions({ candidates: automatic, snapshot: await params.repository.read(), context: params.context, now });
      const persisted = await params.learning.apply({
        batchId: conversationMemoryBatchId(params.context),
        batchExpiresAt: new Date(Date.parse(review.evidence.observedAt) + 86_400_000).toISOString(),
        environmentId: "conversation", observations: [],
        cause: { kind: "conversation_memory_review", evidence: review.evidence },
        context: review.knowledge, decisions: review.decisions,
        policy: await params.learning.policy(), abortSignal: params.context.abortSignal,
      });
      acceptedCount += persisted.candidateIds.length + persisted.recordIds.length;
      duplicateCount += review.duplicateCount;
    }
    return completeCandidateProcessing(params, startedAt, {
      proposedCount: params.candidates.length,
      acceptedCount,
      rejectedCount: prepared.rejectedCount + overflow,
      duplicateCount: prepared.duplicateCount + duplicateCount,
    });
  } catch (error) {
    if (params.context.abortSignal.aborted) {
      throw error;
    }
    return failCandidateProcessing(
      params,
      startedAt,
      classifyMemoryFailure(error),
      acceptedCount,
      duplicateCount,
    );
  }
}

async function saveExplicitlyRequestedMemory(
  params: Pick<Parameters<typeof processMemoryCandidates>[0], "repository" | "management" | "context">,
  candidate: MemoryCandidate,
): Promise<boolean> {
  const snapshot = await params.repository.read();
  const key = normalizeMemoryText(candidate.content);
  const exact = snapshot.records.find((record) => normalizeMemoryText(record.content) === key);
  const target = candidate.assessment?.target;
  const supersedesCandidate = target?.kind === "candidate"
    ? { id: target.id, revision: Number(target.version) } : undefined;
  const alreadyProtectedWithoutCandidate = exact && !canAutomaticallyManageMemory(exact) && !supersedesCandidate;
  if (alreadyProtectedWithoutCandidate) return false;
  const updateTarget = exact ?? (target?.kind === "memory" ? snapshot.records.find((record) => record.id === target.id) : undefined);
  if (target?.kind === "memory" && !updateTarget) throw new Error("learning_conversation_target_stale");
  if (updateTarget) {
    const confirmsStoredFact = exact?.id === updateTarget.id;
    if (!confirmsStoredFact && !canAutomaticallyManageMemory(updateTarget)) throw new Error("learning_conversation_target_protected");
    if (target?.kind === "memory" && !exact && updateTarget.updatedAt !== target.version)
      throw new Error("learning_conversation_target_stale");
    await params.management.update({
      id: updateTarget.id, expectedUpdatedAt: updateTarget.updatedAt,
      content: candidate.content, tags: mergeMemoryTags(updateTarget.tags, candidate.tags),
      ...(supersedesCandidate ? { supersedesCandidate } : {}),
      context: { abortSignal: params.context.abortSignal, debugRequestId: params.context.requestId },
    });
    return true;
  }
  await params.management.create({
    content: candidate.content, tags: candidate.tags, source: "management_api",
    ...(supersedesCandidate ? { supersedesCandidate } : {}),
    context: { abortSignal: params.context.abortSignal, debugRequestId: params.context.requestId },
  });
  return true;
}

type CandidateCounts = Pick<
  MemoryCandidateProcessingResult,
  "proposedCount" | "acceptedCount" | "rejectedCount" | "duplicateCount"
>;

function completeCandidateProcessing(
  params: Pick<Parameters<typeof processMemoryCandidates>[0], "context">,
  startedAt: number,
  counts: CandidateCounts,
): MemoryCandidateProcessingResult {
  const durationMs = Date.now() - startedAt;
  traceLongTermMemoryOperation({
    operation: "save",
    outcome: "completed",
    requestId: params.context.requestId,
    durationMs,
    counts,
  });
  return Object.freeze({ available: true, ...counts });
}

function failCandidateProcessing(
  params: Pick<
    Parameters<typeof processMemoryCandidates>[0],
    "context" | "candidates"
  >,
  startedAt: number,
  reason: string,
  acceptedCount: number,
  duplicateCount: number,
): MemoryCandidateProcessingResult {
  const durationMs = Date.now() - startedAt;
  traceLongTermMemoryOperation({
    operation: "save",
    outcome: "failed",
    requestId: params.context.requestId,
    durationMs,
    reason,
  });
  return Object.freeze({
    available: false,
    proposedCount: params.candidates.length,
    acceptedCount,
    rejectedCount: Math.max(0, params.candidates.length - acceptedCount - duplicateCount),
    duplicateCount,
    reason,
  });
}
