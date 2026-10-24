export declare function parseReasoningModeBudgets(value: string, previous?: Record<string, number>): Record<string, number> | undefined;
export declare function renderReasoningModeBudgets(
  file: { kind: string; id: string; config: Record<string, any> },
  generationPath: string[],
  renderConfigInput: (...args: any[]) => string,
  options?: { supported?: boolean },
): string;
