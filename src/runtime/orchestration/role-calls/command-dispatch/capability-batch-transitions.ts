import { resetRoleCapabilitySelectionSupervisionState } from "../capability-selection-supervision.js";
import { hasCapabilityAuthority } from "../candidate-validation.js";
import {
  type BeginRoleCapabilityBatchCommand,
  type RoleCallFrame,
  type RoleCallPolicy,
  type RoleCallState,
  type RoleCallTransitionResult,
  type RoleCapabilityBatchSettlement,
  type RoleCapabilityExecution,
  type RoleCapabilityObservationBatchEntry,
  type SettleRoleCapabilityBatchCommand,
} from "../contracts.js";
import { assessRoleOperationSupervisionBatchAttempt } from "../operation-supervision.js";
import { commit, findCall, reject } from "../reducer-primitives.js";
import { findActiveCapabilityCaller } from "./active-capability-caller.js";
import { replaceCall } from "./call-frame-state.js";
import {
  createRunningCapabilityExecution,
  nextCapabilityExecutionId,
} from "./capability-execution-state.js";
import { hasValidCapabilityInvocation } from "./capability-invocation.js";
import {
  advanceOperationSupervisionForCapabilitySettlement,
  hasValidCapabilitySettlement,
  settleCapabilityExecutionRecord,
} from "./capability-settlement.js";
import { commitOperationSupervisionIntervention } from "./operation-supervision-intervention.js";

export function beginCapabilityBatch(
  state: RoleCallState,
  command: BeginRoleCapabilityBatchCommand,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const { callId, invocationAttempt, entries } = command;
  const call = findActiveCapabilityCaller({ state, policy, callId });
  if (!call) {
    return reject(state, "capability_caller_invalid");
  }
  if (call.activationCount !== invocationAttempt) {
    return reject(state, "capability_invocation_mismatch");
  }
  if (!hasRunnableCapabilityBatchEntries(entries)) {
    return reject(state, "invalid_command");
  }
  const supervisionDecision = assessRoleOperationSupervisionBatchAttempt({
    state: state.operationSupervision,
    callId,
    invocationAttempt,
    attempts: entries,
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
    state.capabilityExecutions.length + entries.length >
    policy.limits.maxCapabilityExecutions
  ) {
    return reject(state, "capability_execution_limit_exceeded");
  }

  const executions = entries.map((entry, index) =>
    createRunningCapabilityExecution({
      executionId: nextCapabilityExecutionId(state, index),
      callId,
      invocationAttempt,
      capabilityId: entry.capabilityId,
      declaredEffect: "observation",
      intent: entry.intent,
      controlsJson: entry.controlsJson,
      actionFingerprint: entry.actionFingerprint,
    }),
  );
  const executionIds = Object.freeze(
    executions.map((execution) => execution.executionId),
  );
  return commit(
    {
      ...state,
      capabilityExecutionSequence:
        state.capabilityExecutionSequence + executions.length,
      capabilitySelectionSupervision:
        resetRoleCapabilitySelectionSupervisionState(),
      calls: replaceCall(state.calls, {
        ...call,
        status: "waiting_for_capability",
      }),
      capabilityExecutions: [...state.capabilityExecutions, ...executions],
    },
    {
      type: "capability_batch_begun",
      callId,
      executionIds,
    },
  );
}

export function settleCapabilityBatch(
  state: RoleCallState,
  command: SettleRoleCapabilityBatchCommand,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const { callId, settlements } = command;
  const matchedBatch = findMatchingCapabilityBatchSettlement(
    state,
    policy,
    callId,
    settlements,
  );
  if (!matchedBatch) {
    return reject(state, "capability_execution_mismatch");
  }
  const { call, ownedRunning } = matchedBatch;
  if (
    !hasValidCapabilityBatchSettlements(settlements, ownedRunning, call, policy)
  ) {
    return reject(state, "capability_execution_mismatch");
  }

  const byExecutionId = new Map(
    settlements.map((settlement) => [settlement.executionId, settlement]),
  );
  return commit(
    {
      ...state,
      operationSupervision: advanceBatchOperationSupervision(
        state.operationSupervision,
        ownedRunning,
        settlements,
      ),
      calls: replaceCall(state.calls, {
        ...call,
        status: "active",
        activationCount: call.activationCount + 1,
      }),
      capabilityExecutions: state.capabilityExecutions.map((execution) =>
        settleCapabilityExecutionFromBatch(execution, byExecutionId),
      ),
    },
    {
      type: "capability_batch_settled",
      callId,
      executionIds: Object.freeze(
        settlements.map((settlement) => settlement.executionId),
      ),
    },
  );
}

function hasRunnableCapabilityBatchEntries(
  entries: readonly RoleCapabilityObservationBatchEntry[],
): boolean {
  if (!Array.isArray(entries)) return false;
  if (entries.length < 2) return false;
  if (hasDuplicateOperationIdentities(entries)) return false;
  return entries.every(hasValidCapabilityBatchEntry);
}

function hasValidCapabilityBatchEntry(
  entry: RoleCapabilityObservationBatchEntry,
): boolean {
  return hasValidCapabilityInvocation(entry, "observation");
}

type MatchingCapabilityBatchSettlement = Readonly<{
  call: RoleCallFrame;
  ownedRunning: readonly RoleCapabilityExecution[];
}>;

function findMatchingCapabilityBatchSettlement(
  state: RoleCallState,
  policy: RoleCallPolicy,
  callId: string,
  settlements: readonly RoleCapabilityBatchSettlement[],
): MatchingCapabilityBatchSettlement | undefined {
  if (state.phase !== "running") return undefined;
  if (state.activeCallId !== callId) return undefined;
  const call = findCall(state, callId);
  if (!hasCapabilityAuthority(policy.authority, state, call)) return undefined;
  if (call.status !== "waiting_for_capability") return undefined;
  const ownedRunning = state.capabilityExecutions.filter(
    (execution) =>
      execution.callId === callId && execution.status === "running",
  );
  if (ownedRunning.length < 2) return undefined;
  if (settlements.length !== ownedRunning.length) return undefined;
  if (hasMismatchedBatchSettlementOrder(settlements, ownedRunning)) {
    return undefined;
  }
  return { call, ownedRunning };
}

function hasMismatchedBatchSettlementOrder(
  settlements: readonly RoleCapabilityBatchSettlement[],
  ownedRunning: readonly RoleCapabilityExecution[],
): boolean {
  return settlements.some(
    (settlement, index) =>
      settlement.executionId !== ownedRunning[index]?.executionId,
  );
}

function hasValidCapabilityBatchSettlements(
  settlements: readonly RoleCapabilityBatchSettlement[],
  ownedRunning: readonly RoleCapabilityExecution[],
  call: RoleCallFrame,
  policy: RoleCallPolicy,
): boolean {
  for (let index = 0; index < settlements.length; index += 1) {
    if (
      !hasValidCapabilityBatchSettlement(
        settlements[index]!,
        ownedRunning[index]!,
        call,
        policy,
      )
    ) {
      return false;
    }
  }
  return true;
}

function hasValidCapabilityBatchSettlement(
  settlement: RoleCapabilityBatchSettlement,
  execution: RoleCapabilityExecution,
  call: RoleCallFrame,
  policy: RoleCallPolicy,
): boolean {
  if (execution.invocationAttempt !== call.activationCount) return false;
  if (execution.declaredEffect !== "observation") return false;
  return hasValidCapabilitySettlement(settlement, call, execution, policy);
}

function settleCapabilityExecutionFromBatch(
  execution: RoleCapabilityExecution,
  byExecutionId: ReadonlyMap<string, RoleCapabilityBatchSettlement>,
): RoleCapabilityExecution {
  const settlement = byExecutionId.get(execution.executionId);
  if (!settlement) return execution;
  return settleCapabilityExecutionRecord(execution, settlement);
}

function hasDuplicateOperationIdentities(
  entries: readonly RoleCapabilityObservationBatchEntry[],
): boolean {
  const fingerprintsByCapability = new Map<string, Set<string>>();
  for (const entry of entries) {
    const fingerprint = entry.actionFingerprint;
    if (!fingerprint) continue;
    const fingerprints =
      fingerprintsByCapability.get(entry.capabilityId) ?? new Set<string>();
    if (fingerprints.has(fingerprint)) return true;
    fingerprints.add(fingerprint);
    fingerprintsByCapability.set(entry.capabilityId, fingerprints);
  }
  return false;
}

function advanceBatchOperationSupervision(
  current: RoleCallState["operationSupervision"],
  executions: readonly RoleCapabilityExecution[],
  settlements: readonly RoleCapabilityBatchSettlement[],
): RoleCallState["operationSupervision"] {
  return executions.reduce((supervision, execution, index) => {
    const settlement = settlements[index]!;
    return advanceOperationSupervisionForCapabilitySettlement(
      supervision,
      execution,
      settlement,
    );
  }, current);
}
