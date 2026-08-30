import {
  ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX,
  ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH,
  type RoleCapabilityResultReference,
} from "../../role-calls/index.js";

export function normalizeResultReferences(
  input: unknown,
): readonly RoleCapabilityResultReference[] | undefined | null {
  if (input === undefined) return undefined;
  if (
    !Array.isArray(input) ||
    input.length > ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX
  ) {
    return null;
  }
  const targets = new Set<string>();
  const references: RoleCapabilityResultReference[] = [];
  for (const candidate of input) {
    const reference = normalizeToolTargetReference(candidate);
    if (!reference) return null;
    if (targets.has(reference.target)) return null;
    targets.add(reference.target);
    references.push(reference);
  }
  return Object.freeze(references);
}

function normalizeToolTargetReference(
  candidate: unknown,
): RoleCapabilityResultReference | null {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return null;
  }
  const reference = candidate as Record<string, unknown>;
  if (Object.keys(reference).length !== 2) return null;
  if (reference.kind !== "tool_target") return null;
  if (typeof reference.target !== "string") return null;
  if (reference.target.trim().length === 0) return null;
  if (
    reference.target.length > ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH
  ) {
    return null;
  }
  return Object.freeze({
    kind: "tool_target" as const,
    target: reference.target.trim(),
  });
}
