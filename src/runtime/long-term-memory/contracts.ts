import type { ChatMessage } from "../../model-gateway/types.js";
import type { LongTermMemoryManagementService } from "./management/contracts.js";
import type { LearningCandidateRecord, LearningMemoryReceipt, LearningMemoryService } from "./maturation/contracts.js";
import type { MaturationPolicy } from "./maturation/contracts.js";
import type { ConversationMemoryAssessment } from "./maturation/evidence-contracts.js";
import type { MemoryRetentionLifecycle } from "./maturation/retention-lifecycle.js";
import type {
  ObservationMemorySource,
  ObservationMemoryReceipt,
  SaveObservationMemoryInput,
} from "./observation-contracts.js";

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
  /** Optional for older callers; unassessed proposals cannot become memories. */
  assessment?: ConversationMemoryAssessment;
}>;

export type RootAuthoredResponse = Readonly<{
  finalResponse: string;
  memoryCandidates: readonly MemoryCandidate[];
}>;

export type LongTermMemoryProvenance =
  | ObservationMemorySource
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
  /** Absence is protected: old records do not prove absence of manual edits. */
  automaticManagement?: "allowed" | "protected";
  reconsiderAt?: string | null;
  observationSources?: readonly ObservationMemorySource[];
}>;

export type MemoryVectorIndexEntry = Readonly<{
  memoryId: string;
  modelFingerprint: string;
  dimensions: number;
  vector: readonly number[];
}>;

export type LongTermMemoryRepositorySnapshot = Readonly<{
  schemaVersion: 1 | 3 | 4 | 5;
  revision: number;
  knowledgeRevision?: number;
  records: readonly LongTermMemoryRecord[];
  vectors: readonly MemoryVectorIndexEntry[];
  observationReceipts?: readonly ObservationMemoryReceipt[];
  learningCandidates?: readonly LearningCandidateRecord[];
  learningReceipts?: readonly LearningMemoryReceipt[];
  maturationPolicy?: MaturationPolicy;
}>;

export type LongTermMemoryRepositoryState = Pick<
  LongTermMemoryRepositorySnapshot,
  "records" | "vectors" | "observationReceipts" | "learningCandidates" | "learningReceipts" | "maturationPolicy"
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
  retention?: MemoryRetentionLifecycle;
  subscribeChanges?(listener: () => void): () => void;
  learning?: LearningMemoryService;
  saveObservationBatch?(
    input: SaveObservationMemoryInput,
  ): Promise<ObservationMemoryReceipt>;
  observationBatchReceipt?(
    batchId: string,
  ): Promise<ObservationMemoryReceipt | undefined>;
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
