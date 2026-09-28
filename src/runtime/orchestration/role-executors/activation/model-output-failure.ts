import {
  resolveModelOutputFailure,
  type ModelOutputFailure,
} from "../../../model/invalid-output-failure.js";
import { ModelOutputIncompleteError } from "../../../model/provider-completion.js";
import { ModelStepTimeoutError } from "../../../steps/model-step-timeout.js";
import type { RuntimeRoleId } from "../../roles.js";
import { traceDebug } from "../../../observability/debug-logger.js";
import type {
  RoleExecutor,
  RoleExecutorActivationResult,
  RoleExecutorInput,
} from "../contracts.js";

/** Contains recognized model-output failure or step timeout in the current call. */
export async function executeRoleWithModelOutputFailure<TContext, TValue>(
  executor: RoleExecutor<TContext, TValue>,
  input: RoleExecutorInput<TContext>,
  maxSummaryLength: number,
  requestId: string,
): Promise<RoleExecutorActivationResult<TValue>> {
  try {
    return await executor.execute(input);
  } catch (error: unknown) {
    const failure = resolveChildModelOutputFailure(error);
    if (!failure) throw error;
    if (!isModelOutputFailureOwnedByRole(failure, input.call.roleId)) {
      throw error;
    }
    traceDebug("runtime.role_executors", "executor.invalid_output.returning", {
      requestId,
      callId: input.call.callId,
      parentCallId: input.call.parentCallId,
      roleId: input.call.roleId,
      disposition: "return_failed_child",
      ...failure,
    });
    return Object.freeze({
      kind: "terminal",
      outcome: "failed",
      summary: buildModelOutputFailureSummary(failure, input, maxSummaryLength),
    });
  }
}

function resolveChildModelOutputFailure(
  error: unknown,
): ModelOutputFailure | undefined {
  if (error instanceof ModelStepTimeoutError) {
    return Object.freeze({
      code: error.code,
      modelStep: error.modelStep,
      validationStage: error.stage,
      issues: [],
    });
  }
  if (!(error instanceof ModelOutputIncompleteError)) {
    return resolveModelOutputFailure(error);
  }
  if (!error.modelStep) return undefined;
  return Object.freeze({
    code: error.code,
    modelStep: error.modelStep,
    validationStage: error.stage,
    issues: [],
  });
}

function isModelOutputFailureOwnedByRole(
  failure: ModelOutputFailure,
  roleId: RuntimeRoleId,
): boolean {
  switch (failure.modelStep) {
    case "planner.graph":
    case "planner.decision":
      return roleId === "planner";
    case "worker.decision":
    case "worker.result":
    case "capability.controls":
      return roleId === "worker";
    case "auditor.decision":
    case "reviewer.decision":
      return roleId === "reviewer";
    case "context.compact":
      return isDelegatedModelOutputRole(roleId);
    default:
      return false;
  }
}

function isDelegatedModelOutputRole(roleId: RuntimeRoleId): boolean {
  if (roleId === "planner") return true;
  if (roleId === "worker") return true;
  return roleId === "reviewer";
}

function buildModelOutputFailureSummary<TContext>(
  failure: ModelOutputFailure,
  input: RoleExecutorInput<TContext>,
  maxSummaryLength: number,
): string {
  const summary = JSON.stringify({
    kind: "runtime_role_model_output_failure_v1",
    authority: "runtime_validation",
    presenceEffect: "passive_failure_not_work_or_review_evidence",
    callId: input.call.callId,
    parentCallId: input.call.parentCallId,
    roleId: input.call.roleId,
    reason: failure.code,
    modelStep: failure.modelStep,
    validationStage: failure.validationStage,
  });
  if (fitsModelOutputFailureSummary(summary, maxSummaryLength)) return summary;
  // The canonical result still carries failure and exact caller binding when
  // a legal custom result budget is too small for the diagnostic capsule.
  return "Invalid model output.".slice(0, maxSummaryLength);
}

function fitsModelOutputFailureSummary(
  summary: string,
  maxSummaryLength: number,
): boolean {
  return summary.length <= maxSummaryLength;
}
