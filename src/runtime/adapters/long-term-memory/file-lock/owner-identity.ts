/** Opaque caller-owned incarnation metadata; the lock does not interpret it. */
export function isLockOwnerIdentity(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (Buffer.byteLength(value, "utf8") > 256) return false;
  return !/[\x00-\x1f\x7f]/u.test(value);
}

export function hasValidOptionalLockOwnerIdentity(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  return isLockOwnerIdentity(value);
}
