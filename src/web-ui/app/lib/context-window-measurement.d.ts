export type ContextInputMeasurement = Readonly<{
  inputTokens: number;
  measurementKind: "actual" | "estimated";
  measurement: "actual" | "estimated";
  source: string;
  contextWindowTokens: number;
  usedContextPercent: number;
  remainingContextTokens: number;
  remainingContextPercent: number;
  estimatedInputTokens?: number;
  measuredInputTokens?: number;
  metadataMismatch: boolean;
}>;
export type ContextProviderCounts = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}>;
export declare function isContextTokenCount(value: unknown): value is number;
export declare function isContextCapacity(value: unknown): value is number;
export declare function contextUsedPercent(
  inputTokens: number,
  capacity: number,
): number;
export declare function selectContextInputMeasurement(
  message: Record<string, unknown>,
): ContextInputMeasurement | null;
export declare function normalizeContextProviderCounts(
  message: Record<string, unknown>,
): ContextProviderCounts | null;
export declare function selectCompactionPercentages(
  message: Record<string, unknown>,
): { beforePercent: number; afterPercent: number } | null;
