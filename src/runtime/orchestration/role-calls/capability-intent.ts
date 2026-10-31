import { ROLE_CAPABILITY_INVOCATION_INTENT_MAX_LENGTH } from "./contracts.js";
import { isOptionalBoundedText } from "./reducer-primitives.js";

/** Presentation metadata may be absent; supplied text retains its existing bounds. */
export function isOptionalRoleCapabilityIntent(value: unknown): value is string | undefined {
  return isOptionalBoundedText(value, ROLE_CAPABILITY_INVOCATION_INTENT_MAX_LENGTH);
}

export function isCanonicalOptionalRoleCapabilityIntent(value: unknown): value is string | undefined {
  if (!isOptionalRoleCapabilityIntent(value)) return false;
  if (value === undefined) return true;
  return value.trim() === value;
}

/** Preserve supplied values and ordering; absent metadata must not enter saved commands. */
export function omitAbsentRoleCapabilityIntent<T extends Readonly<{ intent?: string }>>(value: T): T {
  if (value.intent !== undefined) return value;
  const { intent: _intent, ...withoutIntent } = value;
  return withoutIntent as T;
}
