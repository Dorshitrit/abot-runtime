import type { ModelReasoningPreference } from "../../../shared/model-reasoning.js";
import type { ConversationReasoningPreferences, ReasoningPreferenceScope } from "../services/conversation-reasoning-preferences.js";
import type { ReasoningProfile } from "../lib/reasoning-preference.js";
export declare function createReasoningBudgetController(options: {
  state: { reasoningBudgetMenuOpen?: boolean };
  dom: { reasoningBudgetButton?: HTMLButtonElement; reasoningBudgetMenu?: HTMLElement; reasoningBudgetControl?: HTMLElement; agentModeButton?: HTMLButtonElement };
  preferences: ConversationReasoningPreferences;
  getScope(): ReasoningPreferenceScope;
  getProfile(): ReasoningProfile | null;
  onApplied?(): void;
  isModeBusy?(): boolean;
  recordControlEvent?(event: { type: string; name: string; tone: string; summary: string }): void;
}): {
  render(): boolean;
  isSaving(): boolean;
  selectedPreference(): ModelReasoningPreference | undefined;
};
