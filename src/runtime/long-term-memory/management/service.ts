import type {
  LongTermMemoryEmbeddingClient,
  LongTermMemoryRepository,
  MemoryClearResult,
} from "../contracts.js";
import type {
  LongTermMemoryManagementContext,
  LongTermMemoryManagementService,
} from "./contracts.js";
import {
  LongTermMemoryManagementError,
  isLongTermMemoryManagementError,
} from "./errors.js";
import {
  clearManagedMemories,
  createManagedMemory,
  deleteManagedMemory,
  updateManagedMemory,
} from "./mutations.js";
import { listMemoryRecords, readMemoryStatus } from "./queries.js";
import { searchManagedMemories } from "./search.js";

type LongTermMemoryManagementWithClear = LongTermMemoryManagementService &
  Readonly<{ clear(): Promise<MemoryClearResult> }>;

export function createLongTermMemoryManagement(params: {
  repository: LongTermMemoryRepository;
  enabled: boolean;
  embeddings?: LongTermMemoryEmbeddingClient;
  now?: () => Date;
  createId?: () => string;
}): LongTermMemoryManagementWithClear {
  return Object.freeze({
    status: () => readMemoryStatus(params),
    list: (input) =>
      runManagementOperation(() => listMemoryRecords(params.repository, input)),
    search: (input) =>
      runActiveManagementOperation(params, input.context, (embeddings) =>
        searchManagedMemories({
          repository: params.repository,
          embeddings,
          input,
        }),
      ),
    create: (input) =>
      runActiveManagementOperation(params, input.context, (embeddings) =>
        createManagedMemory({
          repository: params.repository,
          embeddings,
          input,
          ...(params.now ? { now: params.now } : {}),
          ...(params.createId ? { createId: params.createId } : {}),
        }),
      ),
    update: (input) =>
      runActiveManagementOperation(params, input.context, (embeddings) =>
        updateManagedMemory({
          repository: params.repository,
          embeddings,
          input,
          ...(params.now ? { now: params.now } : {}),
        }),
      ),
    delete: (input) =>
      runManagementOperation(() =>
        deleteManagedMemory(params.repository, input),
      ),
    clear: () =>
      runManagementOperation(() => clearManagedMemories(params.repository)),
  });
}

async function runActiveManagementOperation<T>(
  params: Readonly<{
    enabled: boolean;
    embeddings?: LongTermMemoryEmbeddingClient;
  }>,
  context: LongTermMemoryManagementContext,
  operation: (embeddings: LongTermMemoryEmbeddingClient) => Promise<T>,
): Promise<T> {
  const embeddings = params.embeddings;
  if (!params.enabled || !embeddings) {
    throw new LongTermMemoryManagementError("long_term_memory_disabled");
  }
  try {
    context.abortSignal.throwIfAborted();
    return await operation(embeddings);
  } catch (error) {
    if (context.abortSignal.aborted || isLongTermMemoryManagementError(error)) {
      throw error;
    }
    throw new LongTermMemoryManagementError("long_term_memory_unavailable", {
      cause: error,
    });
  }
}

async function runManagementOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isLongTermMemoryManagementError(error)) {
      throw error;
    }
    throw new LongTermMemoryManagementError("long_term_memory_unavailable", {
      cause: error,
    });
  }
}
