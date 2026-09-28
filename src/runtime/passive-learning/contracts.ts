import type {
  HostObservationEvent,
  PassiveObservation,
  PassiveCollectionState,
} from "../../shared/passive-observation.js";
import type { ObservationMemoryProposal } from "../long-term-memory/observation-contracts.js";
import type { LearningCandidateRecord, LearningKnowledgeContext, LearningMemoryDecision, LearningReviewCause, MaturationPolicy } from "../long-term-memory/maturation/contracts.js";
import type { CoWorkerResourceLimits, CoWorkerResourceUsage } from "./resources/contracts.js";
import type { ProactiveProposal } from "./proactive/contracts.js";
import type { LearningApplicationSummary } from "./application-catalog.js";
import type { CoWorkerReviewProgress, ReviewProgressPort } from "./review-progress.js";

export type PassiveLearningPreferences = Readonly<{
  /** Saved user authorization; activity switches below only control operation. */
  activityPermissions?: Readonly<{ collection: boolean; learning: boolean; proactive: boolean }>;
  enabled: boolean;
  /** Collection and analysis are independently controlled. */
  processingPaused?: boolean;
  modelProfileId?: string;
  excludedApplications: readonly string[];
  /** Holds pending activity for these applications; collection is independent. */
  processingExcludedApplications?: readonly string[];
  analysisIntervalMinutes?: number;
  analysisTrigger?: "interval" | "observations";
  analysisObservationCount?: number;
  analysisWindow?: LearningAnalysisWindow | null;
  collectionWindow?: LearningAnalysisWindow | null;
  proactiveEnabled?: boolean;
  /** Absent inherits the learning model; null explicitly clears an override. */
  proactiveModelProfileId?: string | null;
  proactiveIntervalMinutes?: number;
  proactiveWindow?: LearningAnalysisWindow | null;
  proactiveMessagesPerDay?: number;
  maxConcurrentBatches?: number;
  maturation?: MaturationPolicy;
  resourceLimits?: CoWorkerResourceLimits;
}>;

export type LearningAnalysisWindow = Readonly<{
  start: string;
  end: string;
  timeZone: string;
}>;

export type LearningObservation = PassiveObservation &
  Readonly<{
    deviceId: string;
    revisit?: Readonly<{ firstObservedAt: string; contentUnchanged: true }>;
  }>;
export type LearningBatch = Readonly<{
  id: string;
  createdAt: string;
  generation: string;
  status:
    | "pending"
    | "processing"
    | "saved"
    | "reviewed"
    | "discarded"
    | "failed"
    | "cancelled";
  observations: readonly LearningObservation[];
  recordIds: readonly string[];
  candidateIds?: readonly string[];
  reason?: string;
  completedAt?: string;
  reviewProgress?: CoWorkerReviewProgress;
}>;
export type LearningBatchSummary = Omit<LearningBatch, "observations" | "reviewProgress"> &
  Readonly<{ observationCount: number }>;

export type PassiveLearningStatus = Readonly<{
  preferences: PassiveLearningPreferences;
  state: "off" | PassiveCollectionState;
  reason?: string;
  /** Independent collection state; legacy state may also report processing failure. */
  collectionState?: "off" | PassiveCollectionState;
  collectionReason?: string;
  processingReason?: string;
  deviceId?: string;
  pendingObservations: number;
  reviewPassRemaining?: number;
  /** Retained application-excluded evidence; deletable but not waiting for processing. */
  blockedObservations?: number;
  retentionHours?: number;
  processing: boolean;
  activeBatches?: number;
  effectiveConcurrency?: number;
  nextAnalysisAt?: string;
  lastObservationAt?: string;
  lastBatchAt?: string;
  droppedObservations: number;
  lastBatch?: LearningBatchSummary;
  recentMemories: readonly Readonly<{
    id: string;
    content: string;
    createdAt: string;
  }>[];
  resourceUsage?: CoWorkerResourceUsage & Readonly<{ activeCalls: number }>;
  proactive?: ProactiveStatus;
  nextCollectionAt?: string;
  maintenanceReason?: string;
  reassessment?: LearningReassessmentStatus;
  applications?: readonly LearningApplicationSummary[];
  applicationsOmitted?: number;
}>;

export type LearningReassessmentStatus = Readonly<{
  state: "off" | "waiting" | "reviewing" | "budget_limited" | "failed";
  nextReviewAt?: string;
  reason?: string;
}>;

export type ProactiveStatus = Readonly<{
  state: "off" | "waiting" | "reviewing" | "budget_limited" | "failed";
  deliveredToday?: number;
  nextReviewAt?: string;
  reason?: string;
  proposals: readonly ProactiveProposal[];
}>;
export type LearningChangedEvent = Readonly<{
  type: "proposal_delivered";
  proposalId: string;
  sessionId: string;
}>;

export type PassiveLearningModel = Readonly<{
  validateProfile(profileId: string): void;
  supportsParallelBatches?(profileId: string): boolean;
  review?(input: Readonly<{
    batchId: string;
    observations: readonly LearningObservation[];
    modelProfileId: string;
    signal: AbortSignal;
    context: LearningKnowledgeContext;
    promotionScore: number;
    cause?: LearningReviewCause;
    progress?: ReviewProgressPort;
    expiresAt?: string;
  }>): Promise<readonly LearningMemoryDecision[]>;
  extract(
    input: Readonly<{
      batchId: string;
      observations: readonly LearningObservation[];
      modelProfileId: string;
      signal: AbortSignal;
    }>,
  ): Promise<readonly ObservationMemoryProposal[]>;
}>;

export type PassiveLearningConnection = (
  input: Readonly<{
    ownerId: string;
    leaseId: string;
    abortSignal: AbortSignal;
    excludedApplications: readonly string[];
    onEvent(event: HostObservationEvent): void;
  }>,
) => Promise<Readonly<{ close(): void }>>;

export type PassiveLearningService = Readonly<{
  start(): Promise<void>;
  stop(): Promise<void>;
  configure(
    input: Partial<PassiveLearningPreferences>,
  ): Promise<PassiveLearningStatus>;
  status(): Promise<PassiveLearningStatus>;
  clearPending(): Promise<PassiveLearningStatus>;
  /** Recheck a permission-blocked collector without changing preferences or queued work. */
  restartCollection?(): Promise<PassiveLearningStatus>;
  batches(
    input?: Readonly<{ limit?: number }>,
  ): Promise<readonly LearningBatchSummary[]>;
  batch(id: string): Promise<LearningBatch | undefined>;
  accept(event: HostObservationEvent): void;
  flush(): Promise<void>;
  beginInteractive(): () => void;
  subscribe(listener: (event?: LearningChangedEvent) => void): () => void;
  dismissProposal?(id: string): Promise<void>;
  sessionDeleted?(sessionId: string): Promise<void>;
  notifyKnowledgeChanged?(): void;
  candidates?(): Promise<readonly Omit<LearningCandidateRecord, "embedding">[]>;
}>;
