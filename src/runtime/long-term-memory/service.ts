import type {
  LongTermMemoryEmbeddingClient,
  LongTermMemoryRepository,
  LongTermMemoryService,
} from "./contracts.js";
import { processMemoryCandidates } from "./candidate-processing.js";
import { createLongTermMemorySaveQueue } from "./background-save-queue.js";
import { emitLongTermMemoryEvent, LONG_TERM_MEMORY_EVENTS } from "./events.js";
import { createLongTermMemoryManagement } from "./management/service.js";
import { retrieveLongTermMemories } from "./retrieval.js";

export function createLongTermMemoryService(options: {
  repository: LongTermMemoryRepository;
  enabled: boolean;
  emitClientEvents: boolean;
  embeddings?: LongTermMemoryEmbeddingClient;
  now?: () => Date;
  createId?: () => string;
  backgroundSaveTimeoutMs?: number;
}): LongTermMemoryService {
  const embeddings = resolveEmbeddingClient(options);
  const management = createLongTermMemoryManagement({
    repository: options.repository,
    enabled: options.enabled,
    ...(embeddings ? { embeddings } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.createId ? { createId: options.createId } : {}),
  });
  const processCandidates: LongTermMemoryService["processCandidates"] = async (
    input,
  ) => {
    if (!options.enabled || !embeddings) {
      return Object.freeze({
        available: false,
        proposedCount: input.candidates.length,
        acceptedCount: 0,
        rejectedCount: input.candidates.length,
        duplicateCount: 0,
        reason: "disabled",
      });
    }
    return processMemoryCandidates({
      repository: options.repository,
      embeddings,
      candidates: input.candidates,
      context: input.context,
      ...(options.now ? { now: options.now } : {}),
      ...(options.createId ? { createId: options.createId } : {}),
    });
  };
  const backgroundSaves = createLongTermMemorySaveQueue({
    process: processCandidates,
    ...(options.backgroundSaveTimeoutMs !== undefined
      ? { timeoutMs: options.backgroundSaveTimeoutMs }
      : {}),
  });
  return Object.freeze({
    enabled: options.enabled,
    async retrieve(input) {
      if (!options.enabled || !embeddings) {
        return Object.freeze({
          available: false,
          records: Object.freeze([]),
          reason: "disabled",
        });
      }
      return retrieveLongTermMemories({
        repository: options.repository,
        embeddings,
        query: input.query,
        context: input.context,
        emitClientEvents: options.emitClientEvents,
      });
    },
    processCandidates,
    scheduleCandidates(input) {
      if (!options.enabled || input.candidates.length === 0) return;
      backgroundSaves.enqueue({
        candidates: input.candidates,
        requestId: input.context.requestId,
        sessionId: input.context.sessionId,
      });
      emitLongTermMemoryEvent({
        enabled: options.emitClientEvents,
        context: input.context,
        name: LONG_TERM_MEMORY_EVENTS.SAVE_QUEUED,
        details: { proposedCount: input.candidates.length },
      });
    },
    ...management,
  });
}

function resolveEmbeddingClient(
  options: Readonly<{
    enabled: boolean;
    embeddings?: LongTermMemoryEmbeddingClient;
  }>,
): LongTermMemoryEmbeddingClient | undefined {
  if (options.enabled && !options.embeddings) {
    throw new Error("long_term_memory_embedding_client_required");
  }
  return options.embeddings;
}
