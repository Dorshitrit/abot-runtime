import type {
  LongTermMemoryEmbeddingClient,
  LongTermMemoryRepository,
  LongTermMemoryRequestContext,
  MemoryCandidate,
  MemoryCandidateProcessingResult,
} from "./contracts.js";
import {
  classifyMemoryFailure,
  traceLongTermMemoryOperation,
} from "./diagnostics.js";
import {
  indexMemoryRecordsByContent,
  prepareMemoryCandidates,
} from "./candidate-preparation.js";
import { embedLongTermMemoryTexts } from "./embedding-batches.js";
import { normalizeMemoryText } from "./policies/normalization.js";
import { persistMemoryCandidates } from "./candidate-persistence.js";

export async function processMemoryCandidates(params: {
  repository: LongTermMemoryRepository;
  embeddings: LongTermMemoryEmbeddingClient;
  candidates: readonly MemoryCandidate[];
  context: LongTermMemoryRequestContext;
  now?: () => Date;
  createId?: () => string;
}): Promise<MemoryCandidateProcessingResult> {
  const startedAt = Date.now();
  try {
    params.context.abortSignal.throwIfAborted();
    const prepared = prepareMemoryCandidates(params.candidates);
    if (prepared.candidates.length === 0) {
      return completeCandidateProcessing(params, startedAt, {
        proposedCount: params.candidates.length,
        acceptedCount: 0,
        rejectedCount: prepared.rejectedCount,
        duplicateCount: prepared.duplicateCount,
      });
    }
    const snapshot = await params.repository.read();
    const existingByContent = indexMemoryRecordsByContent(snapshot.records);
    const fresh = prepared.candidates.filter(
      (candidate) =>
        !existingByContent.has(normalizeMemoryText(candidate.content)),
    );
    const embedded = fresh.length
      ? await embedLongTermMemoryTexts({
          embeddings: params.embeddings,
          texts: fresh.map(({ content }) => content),
          abortSignal: params.context.abortSignal,
          debugRequestId: params.context.requestId,
        })
      : undefined;
    params.context.abortSignal.throwIfAborted();
    const persisted = await persistMemoryCandidates({
      ...params,
      preparedCandidates: prepared.candidates,
      freshCandidates: fresh,
      embedded,
    });
    return completeCandidateProcessing(params, startedAt, {
      proposedCount: params.candidates.length,
      acceptedCount: persisted.acceptedCount,
      rejectedCount: prepared.rejectedCount,
      duplicateCount: prepared.duplicateCount + persisted.duplicateCount,
    });
  } catch (error) {
    if (params.context.abortSignal.aborted) {
      throw error;
    }
    return failCandidateProcessing(
      params,
      startedAt,
      classifyMemoryFailure(error),
    );
  }
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
    acceptedCount: 0,
    rejectedCount: params.candidates.length,
    duplicateCount: 0,
    reason,
  });
}
