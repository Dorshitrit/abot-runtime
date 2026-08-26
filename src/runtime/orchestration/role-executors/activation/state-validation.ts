import type {
  RoleCallFrame,
  RoleCallLedgerHead,
  RoleCapabilityExecution,
} from "../../role-calls/index.js";
import { isRuntimeDelegateRoleId } from "../../roles.js";
import {
  sameCallFrame,
  sameCallIdentity,
} from "../shared/runtime-invariants.js";

export function resolveCurrentCall(
  params: Readonly<{
    head: RoleCallLedgerHead;
    requestId: string;
    expectedCall: RoleCallFrame;
  }>,
):
  | Readonly<{ ok: true; call: RoleCallFrame }>
  | Readonly<{ ok: false; issueCode: string }> {
  try {
    if (params.head.state.requestId !== params.requestId) {
      return { ok: false, issueCode: "request_id_mismatch" };
    }
    if (params.head.state.activeCallId !== params.expectedCall.callId) {
      return { ok: false, issueCode: "call_not_current" };
    }
    const call = params.head.state.calls.find(
      (candidate) => candidate.callId === params.expectedCall.callId,
    );
    if (!call) return { ok: false, issueCode: "call_unavailable" };
    if (!isExecutableCall(call)) {
      return { ok: false, issueCode: "call_not_executable" };
    }
    if (!sameCallFrame(call, params.expectedCall)) {
      return { ok: false, issueCode: "call_identity_mismatch" };
    }
    return { ok: true, call };
  } catch {
    return { ok: false, issueCode: "ledger_head_invalid" };
  }
}

export function validateCapabilityContinuation(
  params: Readonly<{
    before: RoleCallLedgerHead;
    after: RoleCallLedgerHead;
    currentCall: RoleCallFrame;
    executionIds: readonly string[];
  }>,
):
  | Readonly<{ ok: true; call: RoleCallFrame }>
  | Readonly<{ ok: false; issueCode: string }> {
  try {
    if (params.after === params.before) {
      return { ok: false, issueCode: "ledger_not_advanced" };
    }
    if (params.after.revision !== params.before.revision + 2) {
      return { ok: false, issueCode: "revision_advance_invalid" };
    }
    if (params.after.policy !== params.before.policy) {
      return { ok: false, issueCode: "policy_changed" };
    }
    const beforeState = params.before.state;
    const afterState = params.after.state;
    if (
      afterState.requestId !== beforeState.requestId ||
      afterState.phase !== beforeState.phase ||
      afterState.phase !== "running" ||
      afterState.rootCallId !== beforeState.rootCallId ||
      afterState.rootResponse !== beforeState.rootResponse ||
      afterState.callSequence !== beforeState.callSequence ||
      afterState.resultSequence !== beforeState.resultSequence ||
      afterState.capabilityExecutionSequence !==
        beforeState.capabilityExecutionSequence + params.executionIds.length ||
      afterState.activeCallId !== params.currentCall.callId ||
      afterState.results !== beforeState.results
    ) {
      return { ok: false, issueCode: "ledger_progress_invalid" };
    }
    if (afterState.calls.length !== beforeState.calls.length) {
      return { ok: false, issueCode: "call_set_changed" };
    }
    const nextCall = afterState.calls.find(
      (candidate) => candidate.callId === params.currentCall.callId,
    );
    if (!nextCall) return { ok: false, issueCode: "call_unavailable" };
    if (
      nextCall.status !== "active" ||
      nextCall.activationCount !== params.currentCall.activationCount + 1 ||
      !sameCallIdentity(nextCall, params.currentCall)
    ) {
      return { ok: false, issueCode: "activation_advance_invalid" };
    }
    for (const beforeCall of beforeState.calls) {
      if (beforeCall.callId === params.currentCall.callId) continue;
      if (
        afterState.calls.find(
          (candidate) => candidate.callId === beforeCall.callId,
        ) !== beforeCall
      ) {
        return { ok: false, issueCode: "unrelated_call_changed" };
      }
    }
    if (
      afterState.capabilityExecutions.length !==
        beforeState.capabilityExecutions.length + params.executionIds.length ||
      !beforeState.capabilityExecutions.every(
        (execution, index) =>
          afterState.capabilityExecutions[index] === execution,
      )
    ) {
      return { ok: false, issueCode: "execution_set_changed" };
    }
    const beforeExecutionIds = new Set(
      beforeState.capabilityExecutions.map(
        (execution) => execution.executionId,
      ),
    );
    if (
      params.executionIds.length < 1 ||
      new Set(params.executionIds).size !== params.executionIds.length ||
      params.executionIds.some((executionId) =>
        beforeExecutionIds.has(executionId),
      )
    ) {
      return { ok: false, issueCode: "execution_not_new" };
    }
    const appendedExecutions = afterState.capabilityExecutions.filter(
      (execution) => !beforeExecutionIds.has(execution.executionId),
    );
    if (appendedExecutions.length !== params.executionIds.length) {
      return { ok: false, issueCode: "execution_set_changed" };
    }
    for (let index = 0; index < params.executionIds.length; index += 1) {
      const execution = appendedExecutions[index];
      if (execution?.executionId !== params.executionIds[index]) {
        return { ok: false, issueCode: "execution_unavailable" };
      }
      const executionIssue = validateSettledExecution({
        execution,
        call: params.currentCall,
      });
      if (executionIssue) {
        return { ok: false, issueCode: executionIssue };
      }
      if (
        params.executionIds.length > 1 &&
        execution.declaredEffect !== "observation"
      ) {
        return { ok: false, issueCode: "execution_batch_effect_invalid" };
      }
    }
    return { ok: true, call: nextCall };
  } catch {
    return { ok: false, issueCode: "continuation_state_invalid" };
  }
}

function validateSettledExecution(
  params: Readonly<{
    execution: RoleCapabilityExecution | undefined;
    call: RoleCallFrame;
  }>,
): string | undefined {
  const execution = params.execution;
  if (!execution) return "execution_unavailable";
  if (execution.callId !== params.call.callId) {
    return "execution_call_mismatch";
  }
  if (execution.invocationAttempt !== params.call.activationCount) {
    return "execution_activation_mismatch";
  }
  if (
    execution.status !== "settled" ||
    execution.outcome === null ||
    execution.observedEffect === null ||
    execution.summary === null ||
    execution.summary.length === 0
  ) {
    return "execution_not_settled";
  }
  return undefined;
}

function isExecutableCall(call: RoleCallFrame): boolean {
  return (
    isRuntimeDelegateRoleId(call.roleId) &&
    call.parentCallId !== null &&
    call.depth >= 1 &&
    call.objective !== null &&
    call.objective.trim().length > 0 &&
    call.status === "active" &&
    Number.isInteger(call.activationCount) &&
    call.activationCount >= 1 &&
    call.resultRef === null
  );
}
