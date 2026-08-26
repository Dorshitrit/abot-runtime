import { traceDebug } from "../../observability/debug-logger.js";
import { classifyRuntimeErrorType } from "../../observability/error-type.js";
import type { RoleCallFrame } from "../role-calls/index.js";
import type { RuntimeDelegateRoleId } from "../roles.js";
import type {
  RoleExecutionOutcome,
  RoleExecutorRegistry,
} from "./contracts.js";

const ROLE_EXECUTOR_LOG_SCOPE = "runtime.role_executors";

type RoleExecutorDiagnosticContext = Readonly<{
  requestId: string;
  call: RoleCallFrame;
  registeredRoleIds: RoleExecutorRegistry<unknown>["roleIds"];
}>;

export type RoleExecutorAttemptDiagnosticContext = Readonly<{
  requestIdLength: number;
  callIdLength: number;
  attemptedRoleId?: RuntimeDelegateRoleId;
  registeredRoleIds: RoleExecutorRegistry<unknown>["roleIds"];
}>;

export function traceRoleExecutorResolved(
  context: RoleExecutorDiagnosticContext,
): void {
  traceDebug(ROLE_EXECUTOR_LOG_SCOPE, "executor.resolved", {
    ...projectCall(context),
  });
}

export function traceRoleExecutorUnavailable(
  context: RoleExecutorAttemptDiagnosticContext,
): void {
  traceDebug(ROLE_EXECUTOR_LOG_SCOPE, "executor.unavailable", {
    ...projectAttempt(context),
  });
}

export function traceRoleExecutorInitialStateRejected(
  context: RoleExecutorAttemptDiagnosticContext,
  issueCode: string,
): void {
  traceDebug(ROLE_EXECUTOR_LOG_SCOPE, "state.rejected", {
    ...projectAttempt(context),
    issueCode,
    turnCount: 0,
  });
}

export function traceRoleExecutorStarted(
  context: RoleExecutorDiagnosticContext,
  params: Readonly<{
    availableChildRoleIds: readonly RuntimeDelegateRoleId[];
    turnCount: number;
  }>,
): void {
  traceDebug(ROLE_EXECUTOR_LOG_SCOPE, "executor.started", {
    ...projectCall(context),
    ...params,
  });
}

export function traceRoleExecutorCompleted(
  context: RoleExecutorDiagnosticContext,
  result: Readonly<{
    outcome: RoleExecutionOutcome;
    summaryLength: number;
    hasValue: boolean;
    turnCount: number;
  }>,
): void {
  traceDebug(ROLE_EXECUTOR_LOG_SCOPE, "executor.completed", {
    ...projectCall(context),
    ...result,
  });
}

export function traceRoleExecutorContinued(
  context: RoleExecutorDiagnosticContext,
  params: Readonly<{
    executionId?: string;
    executionIds?: readonly string[];
    fromActivation: number;
    toActivation: number;
    turnCount: number;
  }>,
): void {
  traceDebug(ROLE_EXECUTOR_LOG_SCOPE, "executor.continued", {
    ...projectCall(context),
    continuationKind: params.executionIds
      ? "capability_batch_execution"
      : "capability_execution",
    ...params,
  });
}

export function traceRoleExecutorChildRequested(
  context: RoleExecutorDiagnosticContext,
  params: Readonly<{
    childRoleId: RuntimeDelegateRoleId;
    childObjectiveLength: number;
    dependencyResolution: "all_prior_direct_siblings_v1";
    inheritedSiblingResultCount: number;
    inheritedSiblingResultRefs: readonly string[];
    dependencyResultCount: number;
    dependencyResultRefs: readonly string[];
    planBindingMode?: "declare" | "select" | "extend";
    plannedItemCount?: number;
    selectedPlanItemIndexes?: readonly number[];
    selectedPlanItemIds?: readonly string[];
    selectedPlanItemCount?: number;
    workerCapabilityCatalogGroupIds?: readonly string[];
    workerCapabilityCatalogGroupCount?: number;
    workingDirectoryIncluded?: boolean;
    workingDirectoryLength?: number;
    fromActivation: number;
    turnCount: number;
  }>,
): void {
  traceDebug(ROLE_EXECUTOR_LOG_SCOPE, "child.requested", {
    ...projectCall(context),
    ...params,
  });
}

export function traceRoleExecutorChildStarted(
  context: RoleExecutorDiagnosticContext,
  params: Readonly<{
    childCallId: string;
    childRoleId: RuntimeDelegateRoleId;
    childDepth: number;
    dependencyResultCount: number;
    dependencyResultRefs: readonly string[];
    planItemIds?: readonly string[];
    workerCapabilityCatalogGroupIds?: readonly string[];
    workerCapabilityCatalogGroupCount?: number;
    workingDirectoryIncluded?: boolean;
    workingDirectoryLength?: number;
    turnCount: number;
  }>,
): void {
  traceDebug(ROLE_EXECUTOR_LOG_SCOPE, "child.started", {
    ...projectCall(context),
    ...params,
  });
}

export function traceRoleExecutorChildCompleted(
  context: RoleExecutorDiagnosticContext,
  params: Readonly<{
    childCallId: string;
    childRoleId: RuntimeDelegateRoleId;
    outcome: RoleExecutionOutcome;
    summaryLength: number;
    turnCount: number;
  }>,
): void {
  traceDebug(ROLE_EXECUTOR_LOG_SCOPE, "child.completed", {
    ...projectCall(context),
    ...params,
  });
}

export function traceRoleExecutorChildContinued(
  context: RoleExecutorDiagnosticContext,
  params: Readonly<{
    childCallId: string;
    childRoleId: RuntimeDelegateRoleId;
    resultRef: string;
    fromActivation: number;
    toActivation: number;
    planItemIds?: readonly string[];
    turnCount: number;
  }>,
): void {
  traceDebug(ROLE_EXECUTOR_LOG_SCOPE, "executor.continued", {
    ...projectCall(context),
    continuationKind: "role_child",
    ...params,
  });
}

export function traceRoleExecutorChildRejected(
  context: RoleExecutorDiagnosticContext,
  params: Readonly<{
    issueCode: string;
    childRoleId?: RuntimeDelegateRoleId;
    fromActivation: number;
    turnCount: number;
  }>,
): void {
  traceDebug(ROLE_EXECUTOR_LOG_SCOPE, "child.rejected", {
    ...projectCall(context),
    issueCode: params.issueCode,
    ...(params.childRoleId ? { childRoleId: params.childRoleId } : {}),
    fromActivation: params.fromActivation,
    turnCount: params.turnCount,
  });
}

export function traceRoleExecutorContinuationRejected(
  context: RoleExecutorDiagnosticContext,
  params: Readonly<{
    issueCode: string;
    executionId?: string;
    executionIds?: readonly string[];
    fromActivation: number;
    turnCount: number;
  }>,
): void {
  traceDebug(ROLE_EXECUTOR_LOG_SCOPE, "continuation.rejected", {
    ...projectCall(context),
    continuationKind: params.executionIds
      ? "capability_batch_execution"
      : "capability_execution",
    issueCode: params.issueCode,
    ...(params.executionId ? { executionId: params.executionId } : {}),
    ...(params.executionIds ? { executionIds: params.executionIds } : {}),
    fromActivation: params.fromActivation,
    turnCount: params.turnCount,
  });
}

export function traceRoleExecutorStateRejected(
  context: RoleExecutorDiagnosticContext,
  issueCode: string,
  turnCount: number,
): void {
  traceDebug(ROLE_EXECUTOR_LOG_SCOPE, "state.rejected", {
    ...projectCall(context),
    issueCode,
    turnCount,
  });
}

export function traceRoleExecutorResultRejected(
  context: RoleExecutorDiagnosticContext,
  issueCode: string,
): void {
  traceDebug(ROLE_EXECUTOR_LOG_SCOPE, "result.rejected", {
    ...projectCall(context),
    validationStage: "executor_result",
    issueCode,
  });
}

export function traceRoleExecutorFailed(
  context: RoleExecutorDiagnosticContext,
  error: unknown,
): void {
  traceDebug(ROLE_EXECUTOR_LOG_SCOPE, "executor.failed", {
    ...projectCall(context),
    errorType: classifyRuntimeErrorType(error),
  });
}

function projectCall(context: RoleExecutorDiagnosticContext) {
  return {
    requestId: context.requestId,
    callId: context.call.callId,
    parentCallId: context.call.parentCallId,
    roleId: context.call.roleId,
    depth: context.call.depth,
    activationCount: context.call.activationCount,
    objectiveLength: context.call.objective?.length ?? 0,
    workingDirectoryIncluded: context.call.workingDirectory !== undefined,
    workingDirectoryLength: context.call.workingDirectory?.length ?? 0,
    registeredRoleIds: context.registeredRoleIds,
  };
}

function projectAttempt(context: RoleExecutorAttemptDiagnosticContext) {
  return {
    requestIdLength: context.requestIdLength,
    callIdLength: context.callIdLength,
    roleIdRecognized: context.attemptedRoleId !== undefined,
    ...(context.attemptedRoleId
      ? { attemptedRoleId: context.attemptedRoleId }
      : {}),
    registeredRoleIds: context.registeredRoleIds,
  };
}
