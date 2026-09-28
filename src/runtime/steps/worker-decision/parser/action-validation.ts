import { isRoleCallResultText } from "../../../orchestration/role-calls/index.js";
import type { WorkerDecisionValidationIssue } from "../contracts.js";
import { validateCapabilityBatchDecision } from "./capability-batch-validation.js";
import { validateSingleCapabilityDecision } from "./capability-invocation-validation.js";
import { validateExactWorkerDecisionKeys } from "./decision-shape-validation.js";
import type {
  ActionValidation,
  DecisionValidationContext,
  WorkerDecisionAction,
} from "./validation-contract.js";
import { createWorkerDecisionIssue } from "./validation-contract.js";

export function readWorkerDecisionAction(
  value: unknown,
): WorkerDecisionAction | undefined {
  if (value === "return_result") return value;
  if (value === "return_failure") return value;
  if (value === "invoke_capability") return value;
  if (value === "invoke_capabilities") return value;
  return undefined;
}

export function validateWorkerDecisionAction(
  action: WorkerDecisionAction | undefined,
  record: Record<string, unknown>,
  context: DecisionValidationContext,
  issues: WorkerDecisionValidationIssue[],
): ActionValidation {
  if (!action) {
    issues.push(
      createWorkerDecisionIssue("worker_action_invalid", "decision.action"),
    );
    return {};
  }
  if (isTerminalWorkerActionUnavailable(action, context.allowedActions)) {
    issues.push(
      createWorkerDecisionIssue(
        "worker_terminal_action_unavailable",
        "decision.action",
        `${action} is unavailable in this Worker decision state; choose one of ${JSON.stringify(context.allowedActions)}.`,
      ),
    );
    return {};
  }
  return validateSelectedWorkerAction(action, record, context, issues);
}

function isTerminalWorkerActionUnavailable(
  action: WorkerDecisionAction,
  allowedActions: readonly WorkerDecisionAction[],
): boolean {
  if (allowedActions.includes(action)) return false;
  if (action === "return_result") return true;
  return action === "return_failure";
}

function validateSelectedWorkerAction(
  action: WorkerDecisionAction,
  record: Record<string, unknown>,
  context: DecisionValidationContext,
  issues: WorkerDecisionValidationIssue[],
): ActionValidation {
  switch (action) {
    case "return_result":
      validateReturnResultDecision(record, issues);
      return {};
    case "return_failure":
      validateReturnFailureDecision(record, issues);
      return {};
    case "invoke_capability":
      return validateSingleCapabilityDecision(record, context, issues);
    case "invoke_capabilities":
      return validateCapabilityBatchDecision(record, context, issues);
  }
}

function validateReturnResultDecision(
  record: Record<string, unknown>,
  issues: WorkerDecisionValidationIssue[],
): void {
  validateExactWorkerDecisionKeys(record, ["action"], issues);
}

function validateReturnFailureDecision(
  record: Record<string, unknown>,
  issues: WorkerDecisionValidationIssue[],
): void {
  validateExactWorkerDecisionKeys(record, ["action", "reason"], issues);
  if (isRoleCallResultText(record.reason)) return;
  issues.push(
    createWorkerDecisionIssue("worker_result_invalid", "decision.reason"),
  );
}
