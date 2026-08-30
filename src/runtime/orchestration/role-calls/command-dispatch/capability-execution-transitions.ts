import { resetRoleCapabilitySelectionSupervisionState } from "../capability-selection-supervision.js";
import { hasCapabilityAuthority } from "../candidate-validation.js";
import {
  type BeginRoleCapabilityExecutionCommand,
  type RoleCallFrame,
  type RoleCallPolicy,
  type RoleCallState,
  type RoleCallTransitionResult,
  type RoleCapabilityExecution,
  type SettleRoleCapabilityExecutionCommand,
} from "../contracts.js";
import { assessRoleOperationSupervisionAttempt } from "../operation-supervision.js";
import { commit, findCall, reject } from "../reducer-primitives.js";
import { findActiveCapabilityCaller } from "./active-capability-caller.js";
import { replaceCall } from "./call-frame-state.js";
import {
  createRunningCapabilityExecution,
  findCapabilityExecution,
  nextCapabilityExecutionId,
  replaceCapabilityExecution,
} from "./capability-execution-state.js";
import { hasValidCapabilityInvocation } from "./capability-invocation.js";
import {
  advanceOperationSupervisionForCapabilitySettlement,
  hasValidCapabilitySettlement,
  settleCapabilityExecutionRecord,
} from "./capability-settlement.js";
import { commitOperationSupervisionIntervention } from "./operation-supervision-intervention.js";

export function beginCapabilityExecution(
  state: RoleCallState,
  command: BeginRoleCapabilityExecutionCommand,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const {
    callId,
    invocationAttempt,
    capabilityId,
    declaredEffect,
    intent,
    controlsJson,
    actionFingerprint,
  } = command;
  const call = findActiveCapabilityCaller({ state, policy, callId });
  if (!call) {
    return reject(state, "capability_caller_invalid");
  }
  if (call.activationCount !== invocationAttempt) {
    return reject(state, "capability_invocation_mismatch");
  }
  if (!hasValidCapabilityInvocation(command)) {
    return reject(state, "invalid_command");
  }
  const supervisionDecision = assessRoleOperationSupervisionAttempt({
    state: state.operationSupervision,
    callId,
    invocationAttempt,
    capabilityId,
    actionFingerprint,
  });
  if (supervisionDecision.disposition === "reject") {
    return reject(state, supervisionDecision.issueCode);
  }
  if (supervisionDecision.disposition === "intervene") {
    return commitOperationSupervisionIntervention({
      state,
      call,
      invocationAttempt,
      operationSupervision: supervisionDecision.state,
      entry: supervisionDecision.entry,
    });
  }
  if (
    state.capabilityExecutions.length >= policy.limits.maxCapabilityExecutions
  ) {
    return reject(state, "capability_execution_limit_exceeded");
  }

  const executionId = nextCapabilityExecutionId(state);
  const execution = createRunningCapabilityExecution({
    executionId,
    callId,
    invocationAttempt,
    capabilityId,
    declaredEffect,
    intent,
    controlsJson,
    actionFingerprint,
  });
  return commit(
    {
      ...state,
      capabilityExecutionSequence: state.capabilityExecutionSequence + 1,
      capabilitySelectionSupervision:
        resetRoleCapabilitySelectionSupervisionState(),
      calls: replaceCall(state.calls, {
        ...call,
        status: "waiting_for_capability",
      }),
      capabilityExecutions: [...state.capabilityExecutions, execution],
    },
    {
      type: "capability_execution_begun",
      callId,
      executionId,
    },
  );
}

export function settleCapabilityExecution(
  state: RoleCallState,
  command: SettleRoleCapabilityExecutionCommand,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const { callId, executionId } = command;
  const matchedSettlement = findMatchingCapabilitySettlement(
    state,
    policy,
    callId,
    executionId,
  );
  if (!matchedSettlement) {
    return reject(state, "capability_execution_mismatch");
  }
  const { call, execution } = matchedSettlement;
  if (!hasValidCapabilitySettlement(command, call, execution, policy)) {
    return reject(state, "capability_execution_mismatch");
  }

  return commit(
    {
      ...state,
      operationSupervision: advanceOperationSupervisionForCapabilitySettlement(
        state.operationSupervision,
        execution,
        command,
      ),
      calls: replaceCall(state.calls, {
        ...call,
        status: "active",
        activationCount: call.activationCount + 1,
      }),
      capabilityExecutions: replaceCapabilityExecution(
        state.capabilityExecutions,
        settleCapabilityExecutionRecord(execution, command),
      ),
    },
    {
      type: "capability_execution_settled",
      callId,
      executionId,
    },
  );
}

type MatchingCapabilitySettlement = Readonly<{
  call: RoleCallFrame;
  execution: RoleCapabilityExecution;
}>;

function findMatchingCapabilitySettlement(
  state: RoleCallState,
  policy: RoleCallPolicy,
  callId: string,
  executionId: string,
): MatchingCapabilitySettlement | undefined {
  if (state.phase !== "running") return undefined;
  if (state.activeCallId !== callId) return undefined;
  const call = findCall(state, callId);
  if (!hasCapabilityAuthority(policy.authority, state, call)) return undefined;
  if (call.status !== "waiting_for_capability") return undefined;
  const execution = findCapabilityExecution(state, executionId);
  if (execution?.status !== "running") return undefined;
  if (execution.callId !== callId) return undefined;
  if (execution.invocationAttempt !== call.activationCount) return undefined;
  const ownedRunningCount = state.capabilityExecutions.filter(
    (candidate) =>
      candidate.callId === callId && candidate.status === "running",
  ).length;
  if (ownedRunningCount !== 1) return undefined;
  return { call, execution };
}
