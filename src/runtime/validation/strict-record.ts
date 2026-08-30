export function exactKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean {
  const required = new Set(requiredKeys);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const actual = Object.keys(value);
  return (
    requiredKeys.every((key) => actual.includes(key)) &&
    actual.every((key) => allowed.has(key)) &&
    actual.length >= required.size &&
    actual.length <= allowed.size
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
