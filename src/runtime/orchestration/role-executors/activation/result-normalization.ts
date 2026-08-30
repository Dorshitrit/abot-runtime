import {
  isRoleCallWorkingDirectoryRoleId,
  normalizeRoleCallWorkingDirectory,
  parseRoleCallPlanBinding,
  parseRoleCallWorkerCapabilityScope,
} from "../../role-calls/index.js";
import { isRuntimeDelegateRoleId } from "../../roles.js";
import type {
  RoleExecutionResult,
  RoleExecutorActivationResult,
  RoleOperationSupervisionInterventionContinuation,
} from "../contracts.js";

export function normalizeRoleExecutorActivationResult<TValue>(
  input: RoleExecutorActivationResult<TValue>,
  maxSummaryLength: number,
  maxObjectiveLength: number,
):
  | Readonly<{
      ok: true;
      value: RoleExecutorActivationResult<TValue>;
    }>
  | Readonly<{ ok: false; issueCode: string }> {
  if (!isPlainRecord(input)) {
    return { ok: false, issueCode: "result_not_object" };
  }
  if (input.kind === "terminal") {
    if (
      !hasExactKeys(input, ["kind", "outcome", "summary"], ["value"]) ||
      (input.outcome !== "completed" && input.outcome !== "failed")
    ) {
      return { ok: false, issueCode: "terminal_shape_invalid" };
    }
    if (
      typeof input.summary !== "string" ||
      input.summary.trim().length === 0 ||
      input.summary.length > maxSummaryLength
    ) {
      return { ok: false, issueCode: "summary_invalid" };
    }
    return {
      ok: true,
      value: Object.freeze({
        kind: "terminal",
        outcome: input.outcome,
        summary: input.summary.trim(),
        ...(input.value !== undefined ? { value: input.value } : {}),
      }) as RoleExecutionResult<TValue>,
    };
  }
  if (input.kind === "invoke_role") {
    const plannerPlan =
      input.plannerPlan === undefined
        ? undefined
        : parseRoleCallPlanBinding(input.plannerPlan);
    const workerCapabilityScope =
      input.workerCapabilityScope === undefined
        ? undefined
        : parseRoleCallWorkerCapabilityScope(input.workerCapabilityScope);
    const workingDirectory = normalizeRoleCallWorkingDirectory(
      input.workingDirectory,
    );
    if (
      !hasExactKeys(
        input,
        ["kind", "roleId", "objective"],
        ["plannerPlan", "workerCapabilityScope", "workingDirectory"],
      ) ||
      !isRuntimeDelegateRoleId(input.roleId) ||
      typeof input.objective !== "string" ||
      input.objective.trim().length === 0 ||
      input.objective.length > maxObjectiveLength ||
      (input.plannerPlan !== undefined && !plannerPlan) ||
      (input.workerCapabilityScope !== undefined && !workerCapabilityScope) ||
      (workerCapabilityScope !== undefined && input.roleId !== "worker") ||
      (input.workingDirectory !== undefined && !workingDirectory) ||
      (workingDirectory !== undefined &&
        !isRoleCallWorkingDirectoryRoleId(input.roleId))
    ) {
      return { ok: false, issueCode: "child_invocation_shape_invalid" };
    }
    return {
      ok: true,
      value: Object.freeze({
        kind: "invoke_role",
        roleId: input.roleId,
        objective: input.objective.trim(),
        ...(workerCapabilityScope ? { workerCapabilityScope } : {}),
        ...(workingDirectory !== undefined ? { workingDirectory } : {}),
        ...(plannerPlan ? { plannerPlan } : {}),
      }),
    };
  }
  if (
    input.kind !== "continue" ||
    !hasExactKeys(input, ["kind", "continuation"]) ||
    !isPlainRecord(input.continuation)
  ) {
    return { ok: false, issueCode: "continuation_shape_invalid" };
  }
  if (
    hasExactKeys(input.continuation, ["kind", "commit"]) &&
    input.continuation.kind === "operation_supervision_intervention" &&
    isPlainRecord(input.continuation.commit)
  ) {
    return {
      ok: true,
      value: Object.freeze({
        kind: "continue",
        continuation: Object.freeze({
          kind: "operation_supervision_intervention",
          commit: input.continuation.commit,
        }) as RoleOperationSupervisionInterventionContinuation,
      }),
    };
  }
  if (
    hasExactKeys(input.continuation, ["kind", "executionId"]) &&
    input.continuation.kind === "capability_execution" &&
    isCapabilityExecutionId(input.continuation.executionId)
  ) {
    return {
      ok: true,
      value: Object.freeze({
        kind: "continue",
        continuation: Object.freeze({
          kind: "capability_execution",
          executionId: input.continuation.executionId,
        }),
      }),
    };
  }
  if (
    hasExactKeys(input.continuation, ["kind", "executionIds"]) &&
    input.continuation.kind === "capability_batch_execution" &&
    Array.isArray(input.continuation.executionIds) &&
    input.continuation.executionIds.length >= 2 &&
    input.continuation.executionIds.every(isCapabilityExecutionId) &&
    new Set(input.continuation.executionIds).size ===
      input.continuation.executionIds.length
  ) {
    return {
      ok: true,
      value: Object.freeze({
        kind: "continue",
        continuation: Object.freeze({
          kind: "capability_batch_execution",
          executionIds: Object.freeze([...input.continuation.executionIds]),
        }),
      }),
    };
  }
  return { ok: false, issueCode: "continuation_shape_invalid" };
}

function hasExactKeys(
  input: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(input);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key)) &&
    keys.length >= required.length &&
    keys.length <= required.length + optional.length
  );
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function isCapabilityExecutionId(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length <= 128 &&
    /^capability-execution-[1-9][0-9]*$/u.test(input)
  );
}
