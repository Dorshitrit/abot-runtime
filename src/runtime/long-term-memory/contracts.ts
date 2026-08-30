import type { ChatMessage } from "../../model-gateway/types.js";
import type { LongTermMemoryManagementService } from "./management/contracts.js";

export type {
  LongTermMemoryManagementContext,
  LongTermMemoryManagementErrorCode,
  LongTermMemoryManagementService,
  MemoryCreateInput,
  MemoryCreateResult,
  MemoryDeleteInput,
  MemoryDeleteResult,
  MemoryListInput,
  MemoryListResult,
  MemoryManagementSource,
  MemorySearchInput,
  MemorySearchResult,
  MemoryUpdateInput,
  MemoryUpdateResult,
} from "./management/contracts.js";

export type MemoryCandidate = Readonly<{
  content: string;
  tags: readonly string[];
}>;

export type RootAuthoredResponse = Readonly<{
  finalResponse: string;
  memoryCandidates: readonly MemoryCandidate[];
}>;

export type LongTermMemoryProvenance =
  | Readonly<{
      kind: "passive_response";
      sourceSessionId: string;
      sourceRequestId: string;
    }>
  | Readonly<{
      kind: "manual";
      source: "web_ui" | "management_api";
    }>;

export type LongTermMemoryRecord = Readonly<{
  id: string;
  content: string;
  tags: readonly string[];
  provenance: LongTermMemoryProvenance;
  createdAt: string;
  updatedAt: string;
}>;

export type MemoryVectorIndexEntry = Readonly<{
  memoryId: string;
  modelFingerprint: string;
  dimensions: number;
  vector: readonly number[];
}>;

export type LongTermMemoryRepositorySnapshot = Readonly<{
  schemaVersion: 1;
  revision: number;
  records: readonly LongTermMemoryRecord[];
  vectors: readonly MemoryVectorIndexEntry[];
}>;

export type LongTermMemoryRepositoryState = Pick<
  LongTermMemoryRepositorySnapshot,
  "records" | "vectors"
>;

export type LongTermMemoryRepository = Readonly<{
  read(): Promise<LongTermMemoryRepositorySnapshot>;
  update(
    mutate: (
      current: LongTermMemoryRepositorySnapshot,
    ) => LongTermMemoryRepositoryState,
  ): Promise<LongTermMemoryRepositorySnapshot>;
}>;

export type LongTermMemoryEmbeddingResult = Readonly<{
  modelFingerprint: string;
  dimensions: number;
  vectors: readonly (readonly number[])[];
}>;

export type LongTermMemoryEmbeddingClient = Readonly<{
  /** Provider-facing maximum for one embedding request. */
  maxBatchSize?: number;
  embed(
    input: Readonly<{
      texts: readonly string[];
      abortSignal: AbortSignal;
      debugRequestId?: string;
    }>,
  ): Promise<LongTermMemoryEmbeddingResult>;
}>;

export type LongTermMemoryStatus = Readonly<{
  enabled: boolean;
  available: boolean;
  recordCount: number;
  indexedRecordCount: number;
  reason?: string;
}>;

export type MemoryClearResult = Readonly<{
  deletedCount: number;
}>;

export type LongTermMemoryRetrieval = Readonly<{
  available: boolean;
  records: readonly LongTermMemoryRecord[];
  message?: ChatMessage;
  reason?: string;
}>;

export type MemoryCandidateProcessingResult = Readonly<{
  available: boolean;
  proposedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  duplicateCount: number;
  reason?: string;
}>;

export type LongTermMemoryRequestContext = Readonly<{
  requestId: string;
  sessionId: string;
  abortSignal: AbortSignal;
  onEvent?: (name: string, extra?: Record<string, unknown>) => void;
}>;

export type LongTermMemoryService = Readonly<{
  enabled: boolean;
  retrieve(
    input: Readonly<{
      query: string;
      context: LongTermMemoryRequestContext;
    }>,
  ): Promise<LongTermMemoryRetrieval>;
  processCandidates(
    input: Readonly<{
      candidates: readonly MemoryCandidate[];
      context: LongTermMemoryRequestContext;
    }>,
  ): Promise<MemoryCandidateProcessingResult>;
  scheduleCandidates(
    input: Readonly<{
      candidates: readonly MemoryCandidate[];
      context: Readonly<{
        requestId: string;
        sessionId: string;
        onEvent?: LongTermMemoryRequestContext["onEvent"];
      }>;
    }>,
  ): void;
  clear(): Promise<MemoryClearResult>;
}> &
  LongTermMemoryManagementService;
