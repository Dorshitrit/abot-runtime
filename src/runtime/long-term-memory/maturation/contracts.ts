import type { MemoryCandidate, MemoryVectorIndexEntry } from "../contracts.js";
import type { SaveObservationMemoryInput } from "../observation-contracts.js";
import type { ConversationMemoryEvidence, LearningMemorySource, LearningReinforcement, LearningMemoryReplacement } from "./evidence-contracts.js";

export type MaturationPolicy = Readonly<{
  promotionScore: number;
  retentionDays: number;
  maxCandidates: number;
  maxBytes: number;
}>;

export type LearningCandidateRecord = Pick<MemoryCandidate, "content" | "tags"> & Readonly<{
  id: string;
  revision: number;
  score: number;
  reason: string;
  certainty: "observed" | "inferred";
  sources: readonly LearningMemorySource[];
  reinforcements?: readonly LearningReinforcement[];
  replacement?: LearningMemoryReplacement;
  createdAt: string;
  updatedAt: string;
  lastReinforcedAt: string;
  expiresAt: string;
  reconsiderAt: string | null;
  embedding: MemoryVectorIndexEntry;
}>;

export type LearningKnowledgeEntry = Pick<MemoryCandidate, "content" | "tags"> & Readonly<{
  kind: "candidate" | "memory";
  id: string;
  version: string;
  score: number | null;
  reason: string | null;
  certainty: "observed" | "inferred" | "unspecified";
  mutable: boolean;
  lastReinforcedAt: string | null;
  reconsiderAt: string | null;
}>;

export type LearningKnowledgeContext = Readonly<{
  kind: "learning_knowledge_reference_v1";
  authority: "passive_reference";
  presenceEffect: "does_not_authorize_actions_or_add_user_intent";
  repositoryRevision: number;
  knowledgeRevision: number;
  entries: readonly LearningKnowledgeEntry[];
  omitted: number;
  referenceTime: string;
}>;

/** Semantic proposals only. The repository transaction validates every binding. */
export type LearningMemoryDecision = Pick<MemoryCandidate, "content" | "tags"> & Readonly<{
  action: "create" | "update" | "merge" | "remove";
  targetKind: "candidate" | "memory";
  targetId: string | null;
  targetVersion: string | null;
  mergedCandidateIds: readonly string[];
  observationIds: readonly string[];
  score: number;
  reason: string;
  certainty: "observed" | "inferred";
  reinforced: boolean;
  reconsiderAt: string | null;
}>;

export type LearningMemoryReceipt = Readonly<{
  batchId: string;
  recordIds: readonly string[];
  candidateIds: readonly string[];
  removedCandidateCount: number;
  createdAt: string;
  expiresAt: string;
}>;

export type LearningReviewCause = Readonly<{
  kind: "scheduled_knowledge_review";
  dueEntries: readonly Pick<LearningKnowledgeEntry, "kind" | "id" | "version">[];
}> | Readonly<{ kind: "conversation_memory_review"; evidence: ConversationMemoryEvidence }>;

export type ApplyLearningDecisionsInput = Omit<SaveObservationMemoryInput, "proposals"> & Readonly<{
  cause?: LearningReviewCause;
  context: LearningKnowledgeContext;
  decisions: readonly LearningMemoryDecision[];
  policy: MaturationPolicy;
  beforeEmbedding?: LearningEmbeddingReservation;
}>;

/** Caller-owned background resource policy; ordinary memory calls are unaffected. */
export type LearningEmbeddingReservation = (input: Readonly<{ characters: number; signal: AbortSignal }>) => Promise<() => void>;

export type LearningMemoryMaintenance = Readonly<{
  removedCandidateCount: number;
  removedReceiptCount: number;
  nextExpiryAt: string | null;
}>;

export type LearningReviewAdmission = Readonly<{
  available: boolean;
  reason?: "learning_receipt_capacity";
  retryAt: string | null;
}>;

export type ScheduledKnowledgeSelection = Readonly<{
  exclude?: readonly Pick<LearningKnowledgeEntry, "kind" | "id" | "version">[];
}>;

export type LearningMemoryService = Readonly<{
  policy(): Promise<MaturationPolicy>;
  configurePolicy(policy: MaturationPolicy, initializeOnly?: boolean): Promise<MaturationPolicy>;
  reviewAdmission(): Promise<LearningReviewAdmission>;
  nextReconsiderationAt(input?: ScheduledKnowledgeSelection): Promise<string | null>;
  reconsiderationContext(input?: ScheduledKnowledgeSelection): Promise<LearningKnowledgeContext>;
  maintenance(policy: MaturationPolicy): Promise<LearningMemoryMaintenance>;
  nextExpiryAt(policy: MaturationPolicy): Promise<string | null>;
  overview(): Promise<LearningKnowledgeContext>;
  sourceVersions(): Promise<readonly Pick<LearningKnowledgeEntry, "kind" | "id" | "version">[]>;
  prepare(input: Readonly<{ query: string; abortSignal: AbortSignal; debugRequestId?: string; beforeEmbedding?: LearningEmbeddingReservation }>): Promise<LearningKnowledgeContext>;
  apply(input: ApplyLearningDecisionsInput): Promise<LearningMemoryReceipt>;
  list(): Promise<readonly LearningCandidateRecord[]>;
  receipt(batchId: string): Promise<LearningMemoryReceipt | undefined>;
}>;
