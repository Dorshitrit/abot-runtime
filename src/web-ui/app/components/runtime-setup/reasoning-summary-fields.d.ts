export type SetupReasoningSummaryState = { provider?: string; providerType?: string; reasoningSummary?: unknown; existingModel?: { reasoningSummary?: unknown; [key: string]: unknown } | null };
export declare function setupReasoningSummaryState(model?: { reasoningSummary?: unknown }): Pick<SetupReasoningSummaryState, "reasoningSummary">;
export declare function updateSetupReasoningSummaryField(state: SetupReasoningSummaryState, field: string, value: unknown): boolean;
export declare function setupReasoningSummaryInput(provider: string, value: unknown): { reasoningSummary?: "auto" | "concise" | "detailed" | null };
export declare function hasSetupReasoningSummaryChanges(state: SetupReasoningSummaryState): boolean;
export declare function renderSetupReasoningSummaryField(state: SetupReasoningSummaryState, readonly?: boolean): string;
export declare function renderSetupReasoningSummaryReview(provider: string, value: unknown): string;
