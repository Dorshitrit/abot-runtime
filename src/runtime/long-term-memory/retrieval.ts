import type {
  LongTermMemoryEmbeddingClient,
  LongTermMemoryRepository,
  LongTermMemoryRequestContext,
  LongTermMemoryRetrieval,
} from "./contracts.js";
import {
  classifyMemoryFailure,
  traceLongTermMemoryOperation,
} from "./diagnostics.js";
import { emitLongTermMemoryEvent, LONG_TERM_MEMORY_EVENTS } from "./events.js";
import { projectLongTermMemoryMessage } from "./projection.js";
import { searchRankedLongTermMemories } from "./ranked-search.js";

export async function retrieveLongTermMemories(params: {
  repository: LongTermMemoryRepository;
  embeddings: LongTermMemoryEmbeddingClient;
  query: string;
  context: LongTermMemoryRequestContext;
  emitClientEvents: boolean;
}): Promise<LongTermMemoryRetrieval> {
  const startedAt = Date.now();
  emitLongTermMemoryEvent({
    enabled: params.emitClientEvents,
    context: params.context,
    name: LONG_TERM_MEMORY_EVENTS.RETRIEVAL_STARTED,
  });
  try {
    const ranked = await searchRankedLongTermMemories({
      repository: params.repository,
      embeddings: params.embeddings,
      query: params.query,
      context: {
        abortSignal: params.context.abortSignal,
        debugRequestId: params.context.requestId,
      },
    });
    return completeRetrieval(
      params,
      startedAt,
      ranked.map(({ record }) => record),
    );
  } catch (error) {
    if (params.context.abortSignal.aborted) {
      throw error;
    }
    return failRetrieval(params, startedAt, classifyMemoryFailure(error));
  }
}

function completeRetrieval(
  params: Pick<
    Parameters<typeof retrieveLongTermMemories>[0],
    "context" | "emitClientEvents"
  >,
  startedAt: number,
  records: LongTermMemoryRetrieval["records"],
): LongTermMemoryRetrieval {
  const message = projectLongTermMemoryMessage(records);
  const durationMs = Date.now() - startedAt;
  traceLongTermMemoryOperation({
    operation: "retrieval",
    outcome: "completed",
    requestId: params.context.requestId,
    durationMs,
    counts: { retrievedCount: records.length },
  });
  emitLongTermMemoryEvent({
    enabled: params.emitClientEvents,
    context: params.context,
    name: LONG_TERM_MEMORY_EVENTS.RETRIEVAL_COMPLETED,
    details: { retrievedCount: records.length, durationMs },
  });
  return Object.freeze({
    available: true,
    records: Object.freeze([...records]),
    ...(message ? { message } : {}),
  });
}

function failRetrieval(
  params: Pick<
    Parameters<typeof retrieveLongTermMemories>[0],
    "context" | "emitClientEvents"
  >,
  startedAt: number,
  reason: string,
): LongTermMemoryRetrieval {
  const durationMs = Date.now() - startedAt;
  traceLongTermMemoryOperation({
    operation: "retrieval",
    outcome: "failed",
    requestId: params.context.requestId,
    durationMs,
    reason,
  });
  emitLongTermMemoryEvent({
    enabled: params.emitClientEvents,
    context: params.context,
    name: LONG_TERM_MEMORY_EVENTS.RETRIEVAL_FAILED,
    details: { reason, durationMs },
  });
  return Object.freeze({
    available: false,
    records: Object.freeze([]),
    reason,
  });
}
