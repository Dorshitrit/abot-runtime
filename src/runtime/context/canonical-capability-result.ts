import {
  isRoleCapabilityId,
  ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
  ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX,
  ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallLedgerHead,
  type RoleCapabilityExecution,
  type RoleCapabilityDeclaredEffect,
  type RoleCapabilityExecutionOutcome,
  type RoleCapabilityObservedEffect,
  type RoleCapabilityResultReference,
} from "../orchestration/role-calls/index.js";
import { normalizeCapabilityAdapterResult } from "../orchestration/capability-adapters/result.js";
import { projectAcceptedCapabilityAction } from "./accepted-capability-action.js";
import type { RequestToolResult } from "./request-tool-results.js";

/** Exact validated ledger evidence, before consumer filtering or supersession. */
export function projectCanonicalRequestToolResult(
  head: RoleCallLedgerHead,
  execution: RoleCapabilityExecution,
): RequestToolResult {
  const exactResult = normalizeCapabilityAdapterResult(execution.exactResult);
  if (
    execution.status !== "settled" ||
    typeof execution.executionId !== "string" ||
    execution.executionId.length === 0 ||
    typeof execution.callId !== "string" ||
    execution.callId.length === 0 ||
    !Number.isSafeInteger(execution.invocationAttempt) ||
    execution.invocationAttempt < 1 ||
    !isRoleCapabilityId(execution.capabilityId) ||
    !isDeclaredEffect(execution.declaredEffect) ||
    !isOutcome(execution.outcome) ||
    !isObservedEffect(execution.observedEffect) ||
    !isBoundedSummary(execution.summary) ||
    !isOptionalBoundedReferenceData(execution.referenceData) ||
    !isValidReferences(execution.references) ||
    !exactResult.ok
  ) {
    throw new Error("request_tool_results_execution_invalid");
  }
  return Object.freeze({
    executionId: execution.executionId,
    callId: execution.callId,
    invocationAttempt: execution.invocationAttempt,
    capabilityId: execution.capabilityId,
    declaredEffect: execution.declaredEffect,
    outcome: execution.outcome,
    observedEffect: execution.observedEffect,
    summary: execution.summary,
    ...(execution.referenceData
      ? { referenceData: execution.referenceData }
      : {}),
    ...(execution.references
      ? { references: Object.freeze([...execution.references]) }
      : {}),
    ...(execution.actionFingerprint
      ? {
          acceptedAction: projectAcceptedCapabilityAction(head, execution),
        }
      : {}),
    adapterResult: exactResult.value,
  });
}

function isDeclaredEffect(
  value: unknown,
): value is RoleCapabilityDeclaredEffect {
  return value === "observation" || value === "mutation" || value === "mixed";
}

function isOutcome(value: unknown): value is RoleCapabilityExecutionOutcome {
  return value === "succeeded" || value === "failed";
}

function isObservedEffect(
  value: unknown,
): value is RoleCapabilityObservedEffect {
  return (
    value === "none" ||
    value === "observation" ||
    value === "mutation" ||
    value === "indeterminate"
  );
}

function isBoundedSummary(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= ROLE_CALL_RESULT_MAX_LENGTH
  );
}

function isOptionalBoundedReferenceData(
  value: unknown,
): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH)
  );
}

function isValidReferences(
  value: RoleCallLedgerHead["state"]["capabilityExecutions"][number]["references"],
): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX &&
      value.every(
        (reference) =>
          reference.kind === "tool_target" &&
          typeof reference.target === "string" &&
          reference.target.trim().length > 0 &&
          reference.target.length <=
            ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH,
      ) &&
      new Set(value.map(({ target }) => target)).size === value.length)
  );
}
