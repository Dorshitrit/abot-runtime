import { resetRoleCapabilitySelectionSupervisionState } from "../capability-selection-supervision.js";
import type {
  RoleCallCommitEffect,
  RoleCallFrame,
  RoleCallState,
  RoleCallTransitionResult,
} from "../contracts.js";
import { commit } from "../reducer-primitives.js";
import { replaceCall } from "./call-frame-state.js";

type OperationSupervisionInterventionEffect = Extract<
  RoleCallCommitEffect,
  { type: "operation_supervision_intervened" }
>;

type OperationSupervisionInterventionEntry = Omit<
  OperationSupervisionInterventionEffect,
  "type" | "callId" | "invocationAttempt"
>;

export function commitOperationSupervisionIntervention(params: {
  state: RoleCallState;
  call: RoleCallFrame;
  invocationAttempt: number;
  operationSupervision: RoleCallState["operationSupervision"];
  entry: OperationSupervisionInterventionEntry;
}): RoleCallTransitionResult {
  return commit(
    {
      ...params.state,
      calls: replaceCall(params.state.calls, {
        ...params.call,
        activationCount: params.call.activationCount + 1,
      }),
      operationSupervision: params.operationSupervision,
      capabilitySelectionSupervision:
        resetRoleCapabilitySelectionSupervisionState(),
    },
    {
      type: "operation_supervision_intervened",
      callId: params.call.callId,
      invocationAttempt: params.invocationAttempt,
      capabilityId: params.entry.capabilityId,
      actionFingerprint: params.entry.actionFingerprint,
      priorOutcome: params.entry.priorOutcome,
      outcomeFingerprint: params.entry.outcomeFingerprint,
      originExecutionId: params.entry.originExecutionId,
      matchingOutcomeCount: params.entry.matchingOutcomeCount,
      interventionCount: params.entry.interventionCount,
    },
  );
}
