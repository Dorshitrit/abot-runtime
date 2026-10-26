import type { ChatMessage } from "../../model-gateway/types.js";

export type ModelStepCompactionScope = "session_history" | "active_request";

/** Feedback from the consumer envelope, local to one additional compaction cycle. */
export type ContextCompactionProjectionRepair = Readonly<{
  reason: "projection_not_reduced";
  originalInputTokens: number;
  candidateInputTokens: number;
  targetInputTokens: number;
}>;

export type ModelStepCompactionPreparationContext = Readonly<{
  boundSteeringVersion?: number;
  projectionRepair?: ContextCompactionProjectionRepair;
}>;

/** Provisional checkpoint. Active-request owners commit synchronously. */
export type ModelStepContextCompactionPreparation = Readonly<{
  messages: readonly ChatMessage[];
  scopeId: string;
  sourceRevision: number | string;
  coveredSourceCount: number;
  /** Trusted exhaustion proof for this stage's scope in the uncommitted candidate. */
  hasExhaustedCompactionSources?: boolean;
  commit(): void | Promise<void>;
}>;

export type ModelStepCompactionStageOutcome =
  | Readonly<{
      kind: "prepared";
      preparation: ModelStepContextCompactionPreparation;
    }>
  | Readonly<{
      kind: "unavailable";
      reason: "no_eligible_sources" | "no_new_sources";
    }>;

export type ModelStepCompactionStage = Readonly<{
  compactionScope: ModelStepCompactionScope;
  scopeId: string;
  /** The owning compactor supports a minimal-instruction projection repair. */
  supportsProjectionRepair?: true;
  prepare(
    messages: readonly ChatMessage[],
    context?: ModelStepCompactionPreparationContext,
  ): Promise<ModelStepCompactionStageOutcome>;
}>;

export type ModelStepContextCompactionController = Readonly<{
  /** Projects committed state once, before the complete envelope is assessed. */
  project(messages: readonly ChatMessage[]): ChatMessage[];
  /**
   * Drops only owned optional context once before semantic compaction.
   * No model calls or persistent effects; mandatory messages remain unchanged.
   * Return the same array when unchanged to avoid another budget measurement.
   */
  projectForCompaction?(
    messages: readonly ChatMessage[],
  ): readonly ChatMessage[];
  /** Trusted projection proof plus a fresh source scan; never model-authored JSON. */
  hasExhaustedVerifiedCompactionSources?(
    messages: readonly ChatMessage[],
  ): boolean;
  /** Ordered, invocation-local plan; never scans sources or calls the model. */
  getStages(): readonly ModelStepCompactionStage[];
}>;
