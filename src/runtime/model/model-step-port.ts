import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";

export type ModelStepOutputDiagnostics = Readonly<{
  outputLength: number;
  transportOutputLength?: number;
  terminalEventCount?: number;
  providerCompletionReason?: string | null;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  providerTotalTokens?: number;
}>;

export type ModelStepContextCompactionPreparation = Readonly<{
  messages: ChatMessage[];
  commit(): void | Promise<void>;
  scopeId: string;
  sourceRevision: number | string;
  coveredSourceCount: number;
}>;

export type ModelStepContextCompactionController = Readonly<{
  compactionScope: "active_request" | "session_history";
  /** Replaces already-covered exact working messages before assessment. */
  project(messages: readonly ChatMessage[]): ChatMessage[];
  /** Generates one replacement checkpoint without committing it yet. */
  prepare(
    messages: readonly ChatMessage[],
  ): Promise<ModelStepContextCompactionPreparation>;
}>;

export type ModelStepInvocationInput<T> = Readonly<{
  modelStep: ModelStep;
  messages: ChatMessage[];
  timeoutReason: string;
  format?: "json" | Record<string, unknown>;
  contextCompaction?: ModelStepContextCompactionController;
  accept(text: string, diagnostics: ModelStepOutputDiagnostics): T;
}>;

/** Request-owned port shared by every model step in one accepted request. */
export type RequestModelStepPort = Readonly<{
  invoke<T>(params: ModelStepInvocationInput<T>): Promise<T>;
}>;
