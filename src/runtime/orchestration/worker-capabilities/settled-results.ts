import {
  isRoleCapabilityId,
  hasRoleCallCapabilityAuthority,
  ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX,
  ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerHead,
  type RoleCapabilityDeclaredEffect,
  type RoleCapabilityExecutionOutcome,
  type RoleCapabilityObservedEffect,
} from "../role-calls/index.js";
import type { WorkerSettledCapabilityResult } from "./contracts.js";
import { normalizeCapabilityAdapterResult } from "../capability-adapters/result.js";

/**
 * Projects every canonical capability result already settled for one exact
 * active capability-authorized role call. The runtime carries all facts; it
 * does not select which result is semantically relevant to the next model
 * action.
 */
export function projectRoleSettledCapabilityResults(params: {
  ledger: RoleCallLedger;
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
}): readonly WorkerSettledCapabilityResult[] {
  if (params.ledger.current() !== params.head) {
    throw new Error("worker_settled_results_head_stale");
  }
  const canonicalCall = params.head.state.calls.find(
    (candidate) => candidate.callId === params.call.callId,
  );
  if (
    params.head.state.phase !== "running" ||
    params.head.state.activeCallId !== params.call.callId ||
    !canonicalCall ||
    !sameActiveRoleCapabilityCall(params.head, params.call, canonicalCall)
  ) {
    throw new Error("worker_settled_results_call_invalid");
  }

  let previousInvocationAttempt = 0;
  const projected: WorkerSettledCapabilityResult[] = [];
  for (const execution of params.head.state.capabilityExecutions) {
    if (execution.callId !== canonicalCall.callId) {
      continue;
    }
    const exactResult = normalizeCapabilityAdapterResult(execution.exactResult);
    if (
      typeof execution.executionId !== "string" ||
      execution.executionId.length === 0 ||
      !Number.isSafeInteger(execution.invocationAttempt) ||
      execution.invocationAttempt < previousInvocationAttempt ||
      execution.invocationAttempt >= canonicalCall.activationCount ||
      !isRoleCapabilityId(execution.capabilityId) ||
      !isCapabilityEffect(execution.declaredEffect) ||
      execution.status !== "settled" ||
      !isCapabilityOutcome(execution.outcome) ||
      !isObservedEffect(execution.observedEffect) ||
      !isBoundedSummary(execution.summary) ||
      !isOptionalBoundedReferenceData(execution.referenceData) ||
      !isValidReferences(execution.references) ||
      !exactResult.ok
    ) {
      throw new Error("worker_settled_results_execution_invalid");
    }
    previousInvocationAttempt = execution.invocationAttempt;
    projected.push(
      Object.freeze({
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
        adapterResult: exactResult.value,
      }),
    );
  }
  return Object.freeze(projected);
}

/** Compatibility name for the existing Worker projection. */
export const projectWorkerSettledCapabilityResults =
  projectRoleSettledCapabilityResults;

function sameActiveRoleCapabilityCall(
  head: RoleCallLedgerHead,
  supplied: RoleCallFrame,
  canonical: RoleCallFrame,
): boolean {
  return (
    hasRoleCallCapabilityAuthority(
      head.policy.authority,
      head.state.rootCallId,
      canonical,
    ) &&
    canonical.status === "active" &&
    canonical.resultRef === null &&
    Number.isSafeInteger(canonical.activationCount) &&
    canonical.activationCount > 0 &&
    supplied.callId === canonical.callId &&
    supplied.parentCallId === canonical.parentCallId &&
    supplied.roleId === canonical.roleId &&
    supplied.depth === canonical.depth &&
    supplied.objective === canonical.objective &&
    supplied.status === canonical.status &&
    supplied.activationCount === canonical.activationCount &&
    supplied.resultRef === canonical.resultRef &&
    sameStrings(supplied.childCallIds, canonical.childCallIds)
  );
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isCapabilityEffect(
  input: unknown,
): input is RoleCapabilityDeclaredEffect {
  return input === "observation" || input === "mutation" || input === "mixed";
}

function isCapabilityOutcome(
  input: unknown,
): input is RoleCapabilityExecutionOutcome {
  return input === "succeeded" || input === "failed";
}

function isObservedEffect(
  input: unknown,
): input is RoleCapabilityObservedEffect {
  return (
    input === "none" ||
    input === "observation" ||
    input === "mutation" ||
    input === "indeterminate"
  );
}

function isBoundedSummary(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.trim().length > 0 &&
    input.length <= ROLE_CALL_RESULT_MAX_LENGTH
  );
}

function isOptionalBoundedReferenceData(
  input: unknown,
): input is string | undefined {
  return (
    input === undefined ||
    (typeof input === "string" &&
      input.trim().length > 0 &&
      input.length <= ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH)
  );
}

function isValidReferences(
  input: RoleCallLedgerHead["state"]["capabilityExecutions"][number]["references"],
): boolean {
  return (
    input === undefined ||
    (Array.isArray(input) &&
      input.length <= ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX &&
      input.every(
        (reference) =>
          reference.kind === "tool_target" &&
          typeof reference.target === "string" &&
          reference.target.trim().length > 0 &&
          reference.target.length <=
            ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH,
      ) &&
      new Set(input.map((reference) => reference.target)).size === input.length)
  );
}
