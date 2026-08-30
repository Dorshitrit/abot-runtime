import type {
  RoleCallFrame,
  RoleCallLedgerHead,
  RoleCallOperationSupervisionInterventionCommit,
  RoleCapabilityExecution,
  RoleOperationSupervisionEntry,
  RoleOperationSupervisionInterventionRecord,
} from "../../role-calls/index.js";
import { isSameRoleOperationIdentity } from "../../role-calls/index.js";
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
      afterState.results !== beforeState.results ||
      afterState.capabilitySelectionSupervision.epoch !== null ||
      afterState.capabilitySelectionSupervision.records.length !== 0
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

export function validateOperationSupervisionInterventionContinuation(
  params: Readonly<{
    before: RoleCallLedgerHead;
    after: RoleCallLedgerHead;
    currentCall: RoleCallFrame;
    commit: RoleCallOperationSupervisionInterventionCommit;
  }>,
):
  | Readonly<{ ok: true; call: RoleCallFrame }>
  | Readonly<{ ok: false; issueCode: string }> {
  try {
    const commitIssue = validateOperationSupervisionInterventionCommit(params);
    if (commitIssue) return { ok: false, issueCode: commitIssue };
    const progressIssue =
      validateOperationSupervisionInterventionProgress(params);
    if (progressIssue) return { ok: false, issueCode: progressIssue };
    const nextCall = params.after.state.calls.find(
      (candidate) => candidate.callId === params.currentCall.callId,
    );
    if (!nextCall) return { ok: false, issueCode: "call_unavailable" };
    const callIssue = validateIntervenedCall({
      before: params.before,
      after: params.after,
      currentCall: params.currentCall,
      nextCall,
    });
    if (callIssue) return { ok: false, issueCode: callIssue };
    const supervisionIssue = validateOperationSupervisionTransition(params);
    if (supervisionIssue) {
      return { ok: false, issueCode: supervisionIssue };
    }
    return { ok: true, call: nextCall };
  } catch {
    return { ok: false, issueCode: "continuation_state_invalid" };
  }
}

function validateOperationSupervisionInterventionCommit(
  params: Readonly<{
    before: RoleCallLedgerHead;
    after: RoleCallLedgerHead;
    currentCall: RoleCallFrame;
    commit: RoleCallOperationSupervisionInterventionCommit;
  }>,
): string | undefined {
  const { commit } = params;
  if (commit.previousHead !== params.before || commit.head !== params.after) {
    return "continuation_commit_mismatch";
  }
  if (commit.effect.type !== "operation_supervision_intervened") {
    return "continuation_effect_invalid";
  }
  if (
    commit.effect.callId !== params.currentCall.callId ||
    commit.effect.invocationAttempt !== params.currentCall.activationCount ||
    commit.effect.matchingOutcomeCount !== 2 ||
    commit.effect.interventionCount !== 1
  ) {
    return "continuation_effect_mismatch";
  }
  return undefined;
}

function validateOperationSupervisionInterventionProgress(
  params: Readonly<{
    before: RoleCallLedgerHead;
    after: RoleCallLedgerHead;
    currentCall: RoleCallFrame;
  }>,
): string | undefined {
  if (params.after === params.before) return "ledger_not_advanced";
  if (params.after.revision !== params.before.revision + 1) {
    return "revision_advance_invalid";
  }
  if (params.after.kind !== params.before.kind) return "ledger_kind_changed";
  if (params.after.policy !== params.before.policy) return "policy_changed";
  const beforeState = params.before.state;
  const afterState = params.after.state;
  const unrelatedStateChanged =
    afterState.contractVersion !== beforeState.contractVersion ||
    afterState.requestId !== beforeState.requestId ||
    afterState.phase !== beforeState.phase ||
    afterState.phase !== "running" ||
    afterState.rootCallId !== beforeState.rootCallId ||
    afterState.rootResponse !== beforeState.rootResponse ||
    afterState.callSequence !== beforeState.callSequence ||
    afterState.resultSequence !== beforeState.resultSequence ||
    afterState.capabilityExecutionSequence !==
      beforeState.capabilityExecutionSequence ||
    afterState.activeCallId !== params.currentCall.callId ||
    afterState.results !== beforeState.results ||
    afterState.plans !== beforeState.plans ||
    afterState.capabilityExecutions !== beforeState.capabilityExecutions ||
    afterState.capabilitySelectionSupervision.epoch !== null ||
    afterState.capabilitySelectionSupervision.records.length !== 0;
  return unrelatedStateChanged ? "ledger_progress_invalid" : undefined;
}

function validateIntervenedCall(
  params: Readonly<{
    before: RoleCallLedgerHead;
    after: RoleCallLedgerHead;
    currentCall: RoleCallFrame;
    nextCall: RoleCallFrame;
  }>,
): string | undefined {
  if (params.after.state.calls.length !== params.before.state.calls.length) {
    return "call_set_changed";
  }
  const callDidNotAdvanceExactlyOnce =
    params.nextCall.status !== "active" ||
    params.nextCall.activationCount !==
      params.currentCall.activationCount + 1 ||
    params.nextCall.lastCapabilitySelectionReconsideration !==
      params.currentCall.lastCapabilitySelectionReconsideration ||
    !sameCallIdentity(params.nextCall, params.currentCall);
  if (callDidNotAdvanceExactlyOnce) return "activation_advance_invalid";
  const unrelatedCallChanged = params.before.state.calls.some(
    (beforeCall) =>
      beforeCall.callId !== params.currentCall.callId &&
      params.after.state.calls.find(
        (candidate) => candidate.callId === beforeCall.callId,
      ) !== beforeCall,
  );
  return unrelatedCallChanged ? "unrelated_call_changed" : undefined;
}

function validateOperationSupervisionTransition(
  params: Readonly<{
    before: RoleCallLedgerHead;
    after: RoleCallLedgerHead;
    commit: RoleCallOperationSupervisionInterventionCommit;
  }>,
): string | undefined {
  const beforeSupervision = params.before.state.operationSupervision;
  const afterSupervision = params.after.state.operationSupervision;
  const effect = params.commit.effect;
  const entryIndex = beforeSupervision.entries.findIndex((entry) =>
    isSameRoleOperationIdentity(entry, effect),
  );
  const beforeEntry = beforeSupervision.entries[entryIndex];
  const afterEntry = afterSupervision.entries[entryIndex];
  const unrelatedEntryChanged = beforeSupervision.entries.some(
    (entry, index) =>
      index !== entryIndex && afterSupervision.entries[index] !== entry,
  );
  const interventionRecord =
    afterSupervision.interventions[afterSupervision.interventions.length - 1];
  const interventionHistoryChangedAppendOnly =
    afterSupervision.interventions.length ===
      beforeSupervision.interventions.length + 1 &&
    beforeSupervision.interventions.every(
      (intervention, index) =>
        afterSupervision.interventions[index] === intervention,
    );
  const transitionDoesNotMatchEffect =
    afterSupervision === beforeSupervision ||
    entryIndex < 0 ||
    afterSupervision.entries.length !== beforeSupervision.entries.length ||
    unrelatedEntryChanged ||
    beforeEntry?.stage !== "warning" ||
    !hasMatchingOperationSupervisionEvidence(beforeEntry, effect) ||
    afterEntry === beforeEntry ||
    afterEntry?.stage !== "intervened" ||
    !hasMatchingOperationSupervisionEvidence(afterEntry, effect) ||
    !hasMatchingOperationSupervisionIntervention(afterEntry, effect) ||
    !interventionHistoryChangedAppendOnly ||
    !interventionRecord ||
    !hasMatchingOperationSupervisionEvidence(interventionRecord, effect) ||
    !hasMatchingOperationSupervisionIntervention(interventionRecord, effect);
  return transitionDoesNotMatchEffect
    ? "operation_supervision_state_invalid"
    : undefined;
}

type OperationSupervisionInterventionEffect =
  RoleCallOperationSupervisionInterventionCommit["effect"];

function hasMatchingOperationSupervisionEvidence(
  evidence:
    | RoleOperationSupervisionEntry
    | RoleOperationSupervisionInterventionRecord,
  effect: OperationSupervisionInterventionEffect,
): boolean {
  return (
    isSameRoleOperationIdentity(evidence, effect) &&
    evidence.priorOutcome === effect.priorOutcome &&
    evidence.outcomeFingerprint === effect.outcomeFingerprint &&
    evidence.originExecutionId === effect.originExecutionId &&
    evidence.matchingOutcomeCount === effect.matchingOutcomeCount
  );
}

function hasMatchingOperationSupervisionIntervention(
  intervention:
    | Extract<RoleOperationSupervisionEntry, { stage: "intervened" }>
    | RoleOperationSupervisionInterventionRecord,
  effect: OperationSupervisionInterventionEffect,
): boolean {
  return (
    intervention.interventionCount === effect.interventionCount &&
    intervention.interventionCallId === effect.callId &&
    intervention.interventionInvocationAttempt === effect.invocationAttempt
  );
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
