export const DEFAULT_MEMORY_RECALL_CALL_LIMIT = 5;

export function isMemoryRecallCallLimit(value: unknown): value is number {
  if (typeof value !== "number") return false;
  if (!Number.isSafeInteger(value)) return false;
  return value > 0;
}

export function canOfferMemoryRecall(
  params: Readonly<{
    enabled: boolean;
    recallCount: number;
    maxRecallCallsPerRequest?: number;
  }>,
): boolean {
  if (!params.enabled) return false;
  const limit =
    params.maxRecallCallsPerRequest ?? DEFAULT_MEMORY_RECALL_CALL_LIMIT;
  return params.recallCount < limit;
}
