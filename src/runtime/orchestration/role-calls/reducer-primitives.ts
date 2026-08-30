import {
  normalizeCapabilityAdapterResult,
  type CapabilityAdapterResult,
} from "../capability-adapters/result.js";
import {
  ROLE_CAPABILITY_INVOCATION_CONTROLS_JSON_MAX_LENGTH,
  ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX,
  ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH,
  type ExecutionPolicyAuthoritySnapshot,
  type RoleCallCommitEffect,
  type RoleCallFrame,
  type RoleCallState,
  type RoleCallTransitionRejectionCode,
  type RoleCallTransitionResult,
  type RoleCallValidationIssue,
  type RoleCapabilityDeclaredEffect,
  type RoleCapabilityExecutionOutcome,
  type RoleCapabilityObservedEffect,
  type RoleCapabilityResultReference,
} from "./contracts.js";
import { exactKeys, isRecord } from "../../validation/strict-record.js";

export { exactKeys, isRecord } from "../../validation/strict-record.js";

export function commit(
  candidate: RoleCallState,
  effect: RoleCallCommitEffect,
): RoleCallTransitionResult {
  return {
    ok: true,
    state: seal(candidate),
    effect: Object.freeze(effect),
  };
}

export function reject(
  state: RoleCallState,
  code: RoleCallTransitionRejectionCode,
  issues?: readonly RoleCallValidationIssue[],
): RoleCallTransitionResult {
  return {
    ok: false,
    state,
    code,
    ...(issues && issues.length > 0
      ? { issues: Object.freeze([...issues]) }
      : {}),
  };
}

export function findCall(
  state: RoleCallState,
  callId: string,
): RoleCallFrame | undefined {
  return state.calls.find((call) => call.callId === callId);
}

export function isExactJsonObjectString(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > ROLE_CAPABILITY_INVOCATION_CONTROLS_JSON_MAX_LENGTH
  ) {
    return false;
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) && JSON.stringify(parsed) === value;
  } catch {
    return false;
  }
}

export function isUniqueStringArray(
  value: unknown,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0) &&
    new Set(value).size === value.length
  );
}

export function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function areOwnedDependencyResults(
  state: RoleCallState,
  caller: RoleCallFrame,
  resultRefs: readonly string[],
  dependentCallIndex = state.calls.length,
): boolean {
  if (!isUniqueStringArray(resultRefs)) return false;
  return resultRefs.every((resultRef) => {
    const result = state.results.find(
      (candidate) => candidate.resultRef === resultRef,
    );
    const producerIndex = state.calls.findIndex(
      (candidate) => candidate.callId === result?.producerCallId,
    );
    const producer = state.calls[producerIndex];
    return (
      result !== undefined &&
      producer !== undefined &&
      producerIndex >= 0 &&
      producerIndex < dependentCallIndex &&
      producer.parentCallId === caller.callId &&
      caller.childCallIds.includes(producer.callId) &&
      producer.status === "completed" &&
      producer.resultRef === resultRef &&
      producer.roleId === result.roleId
    );
  });
}

export function parseOptionalCapabilityAdapterResult(
  input: unknown,
): CapabilityAdapterResult | undefined | null {
  if (input === undefined) return undefined;
  const normalized = normalizeCapabilityAdapterResult(input);
  return normalized.ok ? normalized.value : null;
}

export function isExactResultValidForCall(
  _call: RoleCallFrame,
  input: unknown,
): boolean {
  return normalizeCapabilityAdapterResult(input).ok;
}

export function parseCapabilityResultReferences(
  input: unknown,
): readonly RoleCapabilityResultReference[] | undefined | null {
  if (input === undefined) return undefined;
  if (
    !Array.isArray(input) ||
    input.length > ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX
  ) {
    return null;
  }
  const references: RoleCapabilityResultReference[] = [];
  const targets = new Set<string>();
  for (const candidate of input) {
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, ["kind", "target"]) ||
      candidate.kind !== "tool_target" ||
      !isBoundedText(
        candidate.target,
        ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH,
      )
    ) {
      return null;
    }
    const target = candidate.target.trim();
    if (targets.has(target)) return null;
    targets.add(target);
    references.push(Object.freeze({ kind: "tool_target", target }));
  }
  return Object.freeze(references);
}

export function isValidCapabilityResultReferences(input: unknown): boolean {
  return parseCapabilityResultReferences(input) !== null;
}

export function isBoundedText(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength
  );
}

export function isCanonicalTerminalText(
  value: unknown,
  maximumLength: number,
  mode: ExecutionPolicyAuthoritySnapshot["terminalTextMode"],
): value is string {
  return (
    isBoundedText(value, maximumLength) &&
    (mode === "exact" || value === value.trim())
  );
}

export function isOptionalBoundedText(
  value: unknown,
  maximumLength: number,
): value is string | undefined {
  return value === undefined || isBoundedText(value, maximumLength);
}

export function isRoleCapabilityDeclaredEffect(
  value: unknown,
): value is RoleCapabilityDeclaredEffect {
  return value === "observation" || value === "mutation" || value === "mixed";
}

export function isRoleCapabilityObservedEffect(
  value: unknown,
): value is RoleCapabilityObservedEffect {
  return (
    value === "none" ||
    value === "observation" ||
    value === "mutation" ||
    value === "indeterminate"
  );
}

export function isSettledObservedEffectCompatible(params: {
  declaredEffect: RoleCapabilityDeclaredEffect;
  outcome: RoleCapabilityExecutionOutcome;
  observedEffect: unknown;
}): params is {
  declaredEffect: RoleCapabilityDeclaredEffect;
  outcome: RoleCapabilityExecutionOutcome;
  observedEffect: RoleCapabilityObservedEffect;
} {
  if (!isRoleCapabilityObservedEffect(params.observedEffect)) return false;
  if (params.outcome === "succeeded") {
    return params.declaredEffect === "mixed"
      ? params.observedEffect === "observation" ||
          params.observedEffect === "mutation"
      : params.observedEffect === params.declaredEffect;
  }
  return (
    params.observedEffect === "none" ||
    params.observedEffect === "indeterminate" ||
    params.observedEffect === "observation" ||
    (params.observedEffect === "mutation" &&
      (params.declaredEffect === "mutation" ||
        params.declaredEffect === "mixed"))
  );
}

export function issue(code: string, path: string): RoleCallValidationIssue {
  return { code, path };
}

export function seal<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    seal(child, seen);
  }
  return Object.freeze(value);
}
