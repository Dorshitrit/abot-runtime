export declare function isTokenBudgetModel(file: { id?: string; config?: Record<string, unknown> }, dashboard: unknown, calibration?: { profileId?: string }): boolean;
export declare function shouldRefreshReasoningBudgetFields(
  file: { kind: string },
  path: string[],
  valueType?: string,
): boolean;
export declare function parseReasoningBudgetMode(value: string, previous?: { mode: string; tokens?: number }): { mode: string; tokens?: number } | undefined;
export declare function renderReasoningBudget(
  file: { kind: string; id: string; config: Record<string, unknown> },
  generationPath: string[],
  renderConfigInput: (...args: unknown[]) => string,
  options?: { supported?: boolean; dashboard?: unknown },
): string;
export declare function effectiveReasoningBudgetEffort(file: { config: Record<string, any> }, dashboard: unknown, generationPath: string[]): string | undefined;
export declare function reasoningBudgetStatusText(file: { config: Record<string, any> }, dashboard: unknown, generationPath: string[]): string;
export declare function renderReasoningEffort(file: { config: Record<string, any> }, generationPath: string[], renderConfigInput: (...args: unknown[]) => string): string;
