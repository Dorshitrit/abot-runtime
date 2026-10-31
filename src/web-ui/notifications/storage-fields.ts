export function isNotificationRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null) return false;
  if (typeof value !== "object") return false;
  return !Array.isArray(value);
}

export function hasOnlyNotificationFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isNotificationIdentifier(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.trim() !== value) return false;
  if (!value.length) return false;
  if (value.length > 512) return false;
  return !/[\u0000-\u001f\u007f]/u.test(value);
}

export function isNotificationTimestamp(value: unknown): value is number {
  if (typeof value !== "number") return false;
  if (!Number.isSafeInteger(value)) return false;
  return value >= 0;
}
