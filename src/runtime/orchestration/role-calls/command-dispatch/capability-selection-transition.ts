import {
  createRoleCapabilitySelectionFingerprint,
  normalizeRoleCapabilitySelectionProjection,
} from "../capability-selection-reconsideration.js";
import {
  assessRoleCapabilitySelectionSupervisionReconsideration,
  type RoleCapabilitySelectionSupervisionTrigger,
} from "../capability-selection-supervision.js";
import type {
  ReconsiderRoleCapabilitySelectionCommand,
  RoleCallFrame,
  RoleCallPolicy,
  RoleCallState,
  RoleCallTransitionResult,
  RoleCapabilitySelectionProjection,
  RoleCapabilitySelectionReconsideration,
} from "../contracts.js";
import {
  isReconsiderationCauseBoundToInvocationCount,
  normalizeRoleCapabilitySelectionReconsiderationCause,
  type RoleCapabilitySelectionReconsiderationCause,
} from "../reconsideration-cause.js";
import { commit, reject, sameStringArray } from "../reducer-primitives.js";
import { findActiveCapabilityCaller } from "./active-capability-caller.js";
import { replaceCall } from "./call-frame-state.js";

export function reconsiderCapabilitySelection(
  state: RoleCallState,
  command: ReconsiderRoleCapabilitySelectionCommand,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const { callId, invocationAttempt, steeringVersion, selection, cause } =
    command;
  const call = findActiveCapabilityCaller({ state, policy, callId });
  if (!call) {
    return reject(state, "capability_selection_reconsideration_invalid");
  }
  if (!matchesActiveCapabilitySelection(call, invocationAttempt, selection)) {
    return reject(state, "capability_selection_reconsideration_invalid");
  }
  if (!isNonNegativeSafeSteeringVersion(steeringVersion)) {
    return reject(state, "capability_selection_reconsideration_invalid");
  }
  const normalizedSelection =
    normalizeRoleCapabilitySelectionProjection(selection);
  const normalizedCause =
    normalizeRoleCapabilitySelectionReconsiderationCause(cause);
  if (!normalizedSelection || !normalizedCause) {
    return reject(state, "capability_selection_reconsideration_invalid");
  }
  if (
    !isCauseBoundToSelectedInvocations(normalizedCause, normalizedSelection)
  ) {
    return reject(state, "capability_selection_reconsideration_invalid");
  }
  const fingerprint = createRoleCapabilitySelectionFingerprint({
    steeringVersion,
    selection: normalizedSelection,
  });
  const supervisionEpoch = state.capabilitySelectionSupervision.epoch;
  if (
    !isCompatibleSelectionSupervisionEpoch(
      supervisionEpoch,
      callId,
      steeringVersion,
    )
  ) {
    return reject(state, "capability_selection_reconsideration_invalid");
  }
  const supervision = assessRoleCapabilitySelectionSupervisionReconsideration({
    state: state.capabilitySelectionSupervision,
    callId,
    invocationAttempt,
    steeringVersion,
    receiptFingerprint: fingerprint,
    selection: normalizedSelection,
  });
  if (supervision.disposition === "reject") {
    return reject(state, supervision.issueCode, [
      {
        code: capabilitySelectionLimitIssueCode(supervision.trigger),
        path: "state.capabilitySelectionSupervision",
      },
    ]);
  }
  const reconsideration: RoleCapabilitySelectionReconsideration = {
    invocationAttempt,
    steeringVersion,
    fingerprint,
    selection: normalizedSelection,
    cause: normalizedCause,
  };
  return commit(
    {
      ...state,
      capabilitySelectionSupervision: supervision.state,
      calls: replaceCall(state.calls, {
        ...call,
        activationCount: call.activationCount + 1,
        lastCapabilitySelectionReconsideration: reconsideration,
      }),
    },
    {
      type: "capability_selection_reconsidered",
      callId,
      invocationAttempt,
      fingerprint,
      supervisionFingerprint: supervision.supervisionFingerprint,
      supervisionStage: supervision.disposition,
      supervisionTrigger: supervision.trigger,
      matchingSelectionCount: supervision.identityCount,
      totalReconsiderationCount: supervision.totalCount,
    },
  );
}

function matchesActiveCapabilitySelection(
  call: RoleCallFrame,
  invocationAttempt: number,
  selection: RoleCapabilitySelectionProjection,
): boolean {
  if (call.activationCount !== invocationAttempt) return false;
  const activeScope = call.workerCapabilityScope?.catalogGroupIds;
  if (!activeScope) return false;
  if (
    !sameStringArray(activeScope, selection.activeCapabilityCatalogGroupIds)
  ) {
    return false;
  }
  if (call.workingDirectory === undefined) return true;
  return selection.workingDirectory === call.workingDirectory;
}

function isNonNegativeSafeSteeringVersion(steeringVersion: number): boolean {
  if (!Number.isSafeInteger(steeringVersion)) return false;
  return steeringVersion >= 0;
}

function isCauseBoundToSelectedInvocations(
  cause: RoleCapabilitySelectionReconsiderationCause,
  selection: RoleCapabilitySelectionProjection,
): boolean {
  return isReconsiderationCauseBoundToInvocationCount(
    cause,
    selection.invocations.length,
  );
}

function isCompatibleSelectionSupervisionEpoch(
  epoch: RoleCallState["capabilitySelectionSupervision"]["epoch"],
  callId: string,
  steeringVersion: number,
): boolean {
  if (!epoch) return true;
  if (epoch.callId !== callId) return false;
  return steeringVersion >= epoch.steeringVersion;
}

function capabilitySelectionLimitIssueCode(
  trigger: RoleCapabilitySelectionSupervisionTrigger,
): string {
  if (trigger === "repeat_identity") {
    return "capability_selection_repeat_limit_exceeded";
  }
  if (trigger === "total_budget") {
    return "capability_selection_total_limit_exceeded";
  }
  return "capability_selection_repeat_and_total_limit_exceeded";
}
