import type { AgentMode, ModelReasoningLevel } from "./types.js";
import type { ModelReasoningBudget, ModelReasoningPreference } from "./model-reasoning.js";

/** Display evidence only; these fields never select or override an invocation. */
export type RequestModelSelectionPresentation = Readonly<{
  selectedAt: number;
  primaryProfileId?: string;
  agentMode?: AgentMode;
  reasoningPreference?: ModelReasoningPreference;
  rootModelSteps?: readonly string[];
  primaryModel?: Readonly<{ label: string; provider: string; model: string }>;
}>;

export type InvocationReasoningPresentation = Readonly<{
  reasoningEffort?: ModelReasoningLevel;
  reasoningBudget?: ModelReasoningBudget;
  reasoningControlSource?: "invocation" | "request" | "configuration" | "agent-mode";
}>;

export type EffectiveModelReasoning = InvocationReasoningPresentation & Readonly<{
  profileId: string;
  modelStep: string;
}>;
