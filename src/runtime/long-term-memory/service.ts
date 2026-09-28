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
import { saveObservationMemoryBatch } from "./observation-persistence.js";
import { createLearningMemoryService } from "./maturation/service.js";
import { observeMemoryChanges } from "./change-notifications.js";
import { createMemoryRetentionLifecycle } from "./maturation/retention-lifecycle.js";

export function createLongTermMemoryService(options: {
  repository: LongTermMemoryRepository;
  enabled: boolean;
  emitClientEvents: boolean;
  embeddings?: LongTermMemoryEmbeddingClient;
  now?: () => Date;
  createId?: () => string;
  backgroundSaveTimeoutMs?: number;
}): LongTermMemoryService {
  const changes = observeMemoryChanges(options.repository);
  options = { ...options, repository: changes.repository };
  const embeddings = resolveEmbeddingClient(options);
  const retention = createMemoryRetentionLifecycle({ repository: options.repository,
    subscribeCommits: changes.subscribeCommits, ...(options.now ? { now: options.now } : {}) });
  const learning = embeddings ? createLearningMemoryService({ ...options, embeddings }) : undefined;
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
    if (!options.enabled || !learning) {
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
      learning,
      management,
      candidates: input.candidates,
      context: input.context,
      ...(options.now ? { now: options.now } : {}),
    });
  };
  const backgroundSaves = createLongTermMemorySaveQueue({
    process: processCandidates,
    ...(options.backgroundSaveTimeoutMs !== undefined
      ? { timeoutMs: options.backgroundSaveTimeoutMs }
      : {}),
  });
  return Object.freeze({
    retention,
    subscribeChanges: changes.subscribe,
    enabled: options.enabled,
    ...(learning ? { learning } : {}),
    async observationBatchReceipt(batchId) {
      const snapshot = await options.repository.read();
      const learned = snapshot.learningReceipts?.find((receipt) => receipt.batchId === batchId);
      if (learned) return learned;
      return snapshot.observationReceipts?.find(
        (receipt) => receipt.batchId === batchId,
      );
    },
    async saveObservationBatch(input) {
      if (!options.enabled || !learning)
        throw new Error("long_term_memory_disabled");
      return saveObservationMemoryBatch({
        repository: options.repository,
        learning,
        input,
        ...(options.now ? { now: options.now } : {}),
      });
    },
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
