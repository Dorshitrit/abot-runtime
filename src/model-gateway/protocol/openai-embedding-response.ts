export function readOpenAiCompatibleEmbeddingVectors(
  value: unknown,
  expectedCount: number,
): unknown[] {
  const body =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (!body || !Array.isArray(body.data)) {
    return [];
  }
  const entries = body.data.filter(isRecord);
  if (!hasContiguousIndices(entries, expectedCount)) {
    return [];
  }
  return [...entries]
    .sort((left, right) => Number(left.index) - Number(right.index))
    .map((entry) => entry.embedding);
}

function hasContiguousIndices(
  entries: readonly Record<string, unknown>[],
  expectedCount: number,
): boolean {
  if (entries.length !== expectedCount) {
    return false;
  }
  const indices = new Set(entries.map(({ index }) => index));
  return (
    indices.size === expectedCount &&
    [...indices].every(
      (index) =>
        Number.isSafeInteger(index) &&
        Number(index) >= 0 &&
        Number(index) < expectedCount,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
