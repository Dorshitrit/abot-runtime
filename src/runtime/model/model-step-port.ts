import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import type { ModelStepContextCompactionController } from "./context-compaction-contracts.js";

export type {
  ModelStepCompactionScope,
  ModelStepCompactionStage,
  ModelStepCompactionStageOutcome,
  ModelStepContextCompactionController,
  ModelStepContextCompactionPreparation,
} from "./context-compaction-contracts.js";

export type ModelStepOutputDiagnostics = Readonly<{
  outputLength: number;
  /** Runtime-owned steering snapshot used by this provider attempt. */
  steeringVersion?: number;
  transportOutputLength?: number;
  terminalEventCount?: number;
  providerCompletionReason?: string | null;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  providerTotalTokens?: number;
}>;

export type ModelStepInvocationInput<T> = Readonly<{
  modelStep: ModelStep;
  messages: ChatMessage[];
  timeoutReason: string;
  /** A frozen caller decision; supersession returns control instead of retrying this step. */
  boundSteeringVersion?: number;
  format?: "json" | Record<string, unknown>;
  /** Exact input bypasses compaction, but must fit the shared input budget. */
  contextRetention?: "exact";
  contextCompaction?: ModelStepContextCompactionController;
  /** Async validators must forward this attempt signal to their own work. */
  accept(
    text: string,
    diagnostics: ModelStepOutputDiagnostics,
    abortSignal: AbortSignal,
  ): T | Promise<T>;
}>;

/** Request-owned port shared by every model step in one accepted request. */
export type RequestModelStepPort = Readonly<{
  invoke<T>(params: ModelStepInvocationInput<T>): Promise<T>;
}>;
