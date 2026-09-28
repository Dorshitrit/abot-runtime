/** Omit absent optional fields while rejecting values outside the persisted JSON contract. */
export function captureApprovalSnapshotData<T>(input: T): T {
  return captureValue(input, new Set<object>()) as T;
}

function captureValue(input: unknown, ancestors: Set<object>): unknown {
  if (input === null || typeof input === "string" || typeof input === "boolean")
    return input;
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input !== "object" || input === null)
    throw new Error("approval_snapshot_value_not_serializable");
  if (ancestors.has(input)) throw new Error("approval_snapshot_cycle");
  ancestors.add(input);
  try {
    if (Array.isArray(input))
      return input.map((value) => captureValue(value, ancestors));
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error("approval_snapshot_object_not_serializable");
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) result[key] = captureValue(value, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(input);
  }
}
