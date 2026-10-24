import type { ModelReasoningPreference } from "../../../shared/model-reasoning.js";
export type ReasoningProfile = { id?: string; supportsThinking?: boolean; reasoningControls?: { budgetTokens: boolean } };
export declare const MAX_REASONING_BUDGET_TOKENS: number;
export declare function canChooseReasoningBudget(profile: ReasoningProfile | null | undefined): boolean;
export declare function isReasoningPreference(value: unknown): value is ModelReasoningPreference;
export declare function reasoningPreferenceLabel(preference?: ModelReasoningPreference): string;
export declare function renderReasoningPreferenceField(profile?: ReasoningProfile | null, preference?: ModelReasoningPreference): string;
export declare function syncReasoningPreferenceField(form: ParentNode, profile?: ReasoningProfile | null): void;
export declare function readReasoningPreferenceField(form: ParentNode): ModelReasoningPreference | undefined;
