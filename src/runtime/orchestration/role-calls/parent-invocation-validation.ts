import type {
  RoleCallFrame,
  RoleCallState,
  RoleCallValidationIssue,
} from "./contracts.js";
import { issue } from "./reducer-primitives.js";

/** Preserve unknown legacy chronology; validate only a recorded opening activation. */
export function validateRoleCallParentInvocations(
  state: RoleCallState,
): RoleCallValidationIssue[] {
  const issues: RoleCallValidationIssue[] = [];
  const calls = new Map(state.calls.map((call) => [call.callId, call]));
  const parentAttempts = new Map<string, Set<number>>();
  for (const call of state.calls) {
    if (!Object.hasOwn(call, "parentInvocationAttempt")) continue;
    const parent = calls.get(call.parentCallId ?? "");
    if (!hasBoundParentInvocation(call, parent)) {
      issues.push(issue(
        "invalid_role_call_parent_invocation",
        `state.calls.${call.callId}.parentInvocationAttempt`,
      ));
      continue;
    }
    if (!claimUniqueParentInvocation(parentAttempts, call.parentCallId, call.parentInvocationAttempt)) {
      issues.push(issue(
        "duplicate_role_call_parent_invocation",
        `state.calls.${call.callId}.parentInvocationAttempt`,
      ));
    }
  }
  return issues;
}

function hasBoundParentInvocation(
  call: RoleCallFrame,
  parent: RoleCallFrame | undefined,
): call is RoleCallFrame & { parentCallId: string; parentInvocationAttempt: number } {
  const attempt = call.parentInvocationAttempt;
  if (typeof attempt !== "number") return false;
  if (!Number.isSafeInteger(attempt)) return false;
  if (attempt < 1) return false;
  if (call.parentCallId === null) return false;
  if (!parent) return false;
  if (!Array.isArray(parent.childCallIds)) return false;
  if (!parent.childCallIds.includes(call.callId)) return false;
  if (attempt > parent.activationCount) return false;
  if (call.status === "completed") return attempt < parent.activationCount;
  return true;
}

function claimUniqueParentInvocation(
  parentAttempts: Map<string, Set<number>>,
  parentCallId: string,
  invocationAttempt: number,
): boolean {
  const attempts = parentAttempts.get(parentCallId) ?? new Set<number>();
  if (attempts.has(invocationAttempt)) return false;
  attempts.add(invocationAttempt);
  parentAttempts.set(parentCallId, attempts);
  return true;
}
