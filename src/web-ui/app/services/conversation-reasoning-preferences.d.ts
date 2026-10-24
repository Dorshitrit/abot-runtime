import type { ModelReasoningPreference } from "../../../shared/model-reasoning.js";
export type ReasoningPreferenceScope = { environmentId: string; sessionId?: string };
export interface ConversationReasoningPreferences {
  loadReasoningPreference(scope: ReasoningPreferenceScope, profileId: string): ModelReasoningPreference | undefined;
  saveReasoningPreference(scope: ReasoningPreferenceScope, profileId: string, preference?: ModelReasoningPreference): void | Promise<unknown>;
}
export declare const REASONING_PREFERENCES_KEY: string;
export declare function createConversationReasoningPreferences(storage: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void | Promise<unknown>;
}): ConversationReasoningPreferences;
