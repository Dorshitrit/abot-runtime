import type {
  RoleCallFrame,
  RoleCallLedger,
  RoleCallLedgerHead,
} from "../../role-calls/index.js";
import type {
  RoleExecutionContinuation,
  RoleExecutionContinuationReference,
} from "../contracts.js";
import {
  traceRoleExecutorContinued,
  traceRoleExecutorContinuationRejected,
} from "../diagnostics.js";
import type { RoleExecutorDiagnosticContext } from "../shared/diagnostic-context.js";
import {
  continuationError,
  readLedgerOrReject,
} from "../shared/runtime-invariants.js";
import {
  validateCapabilityContinuation,
  validateOperationSupervisionInterventionContinuation,
} from "./state-validation.js";

export type RoleCapabilityContinuationResolution = Readonly<{
  call: RoleCallFrame;
  continuationReference?: RoleExecutionContinuationReference;
}>;

export function continueRoleThroughCapability(
  params: Readonly<{
    ledger: RoleCallLedger;
    before: RoleCallLedgerHead;
    currentCall: RoleCallFrame;
    diagnostic: RoleExecutorDiagnosticContext;
    continuation: RoleExecutionContinuation["continuation"];
    turnCount: number;
  }>,
): RoleCapabilityContinuationResolution {
  const after = readLedgerOrReject({
    ledger: params.ledger,
    diagnostic: params.diagnostic,
    turnCount: params.turnCount,
  });
  if (params.continuation.kind === "operation_supervision_intervention") {
    return continueAfterOperationSupervisionIntervention(
      { ...params, continuation: params.continuation },
      after,
    );
  }
  return continueAfterCapabilityExecution(
    { ...params, continuation: params.continuation },
    after,
  );
}

function continueAfterCapabilityExecution(
  params: Readonly<{
    before: RoleCallLedgerHead;
    currentCall: RoleCallFrame;
    diagnostic: RoleExecutorDiagnosticContext;
    continuation: Exclude<
      RoleExecutionContinuation["continuation"],
      { kind: "operation_supervision_intervention" }
    >;
    turnCount: number;
  }>,
  after: RoleCallLedgerHead,
): RoleCapabilityContinuationResolution {
  const executionIds =
    params.continuation.kind === "capability_batch_execution"
      ? params.continuation.executionIds
      : [params.continuation.executionId];
  const continuation = validateCapabilityContinuation({
    before: params.before,
    after,
    currentCall: params.currentCall,
    executionIds,
  });
  const diagnosticIds =
    params.continuation.kind === "capability_batch_execution"
      ? { executionIds }
      : { executionId: executionIds[0] };
  if (!continuation.ok) {
    traceRoleExecutorContinuationRejected(params.diagnostic, {
      continuationKind: params.continuation.kind,
      issueCode: continuation.issueCode,
      ...diagnosticIds,
      fromActivation: params.currentCall.activationCount,
      turnCount: params.turnCount,
    });
    throw continuationError(params.currentCall.roleId, continuation.issueCode);
  }
  traceRoleExecutorContinued(params.diagnostic, {
    continuationKind: params.continuation.kind,
    ...diagnosticIds,
    fromActivation: params.currentCall.activationCount,
    toActivation: continuation.call.activationCount,
    turnCount: params.turnCount,
  });
  return Object.freeze({
    call: continuation.call,
    continuationReference: params.continuation,
  });
}

function continueAfterOperationSupervisionIntervention(
  params: Readonly<{
    before: RoleCallLedgerHead;
    currentCall: RoleCallFrame;
    diagnostic: RoleExecutorDiagnosticContext;
    continuation: Extract<
      RoleExecutionContinuation["continuation"],
      { kind: "operation_supervision_intervention" }
    >;
    turnCount: number;
  }>,
  after: RoleCallLedgerHead,
): RoleCapabilityContinuationResolution {
  const continuation = validateOperationSupervisionInterventionContinuation({
    before: params.before,
    after,
    currentCall: params.currentCall,
    commit: params.continuation.commit,
  });
  if (!continuation.ok) {
    traceRoleExecutorContinuationRejected(params.diagnostic, {
      continuationKind: params.continuation.kind,
      issueCode: continuation.issueCode,
      fromActivation: params.currentCall.activationCount,
      turnCount: params.turnCount,
    });
    throw continuationError(params.currentCall.roleId, continuation.issueCode);
  }
  traceRoleExecutorContinued(params.diagnostic, {
    continuationKind: params.continuation.kind,
    fromActivation: params.currentCall.activationCount,
    toActivation: continuation.call.activationCount,
    turnCount: params.turnCount,
  });
  return Object.freeze({ call: continuation.call });
}
