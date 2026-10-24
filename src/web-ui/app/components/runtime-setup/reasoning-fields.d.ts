import type { ModelReasoningBudget } from "../../../../shared/model-reasoning.js";
export type SetupReasoningState = {
  provider?: string;
  providerType?: string;
  supportsThinking?: boolean;
  reasoningBudgetMode?: string;
  reasoningBudgetTokens?: string;
};
export declare function setupReasoningState(model?: { supportsThinking?: boolean; reasoningBudget?: ModelReasoningBudget }): SetupReasoningState;
export declare function updateSetupReasoningField(state: SetupReasoningState, field: string, value: string | boolean): boolean;
export declare function renderSetupReasoningFields(state: SetupReasoningState, readonly?: boolean): string;
export declare function validateSetupReasoningFields(state: SetupReasoningState): {
  valid: boolean;
  input?: { supportsThinking?: boolean; reasoningBudget?: ModelReasoningBudget };
  field?: string;
  message?: string;
};
