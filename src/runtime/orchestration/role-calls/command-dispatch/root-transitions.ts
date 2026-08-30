import { RUNTIME_ROOT_ROLE_ID } from "../../roles.js";
import { resetRoleCapabilitySelectionSupervisionState } from "../capability-selection-supervision.js";
import type {
  CompleteRootResponseCommand,
  RoleCallFrame,
  RoleCallPolicy,
  RoleCallState,
  RoleCallTransitionResult,
} from "../contracts.js";
import {
  commit,
  findCall,
  isBoundedText,
  reject,
} from "../reducer-primitives.js";
import { nextCallId, replaceCall } from "./call-frame-state.js";

export function createRoot(state: RoleCallState): RoleCallTransitionResult {
  if (hasExistingCanonicalRoot(state)) {
    return reject(state, "root_already_created");
  }
  const callId = nextCallId(state);
  const root: RoleCallFrame = {
    callId,
    parentCallId: null,
    roleId: RUNTIME_ROOT_ROLE_ID,
    depth: 0,
    objective: null,
    dependencyResultRefs: [],
    status: "active",
    childCallIds: [],
    activationCount: 1,
    resultRef: null,
  };
  return commit(
    {
      ...state,
      phase: "running",
      rootCallId: callId,
      activeCallId: callId,
      callSequence: state.callSequence + 1,
      calls: [...state.calls, root],
    },
    { type: "root_created", callId },
  );
}

export function completeRootResponse(
  state: RoleCallState,
  command: CompleteRootResponseCommand,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const { callId, response } = command;
  if (state.phase === "empty") {
    return reject(state, "root_missing");
  }
  const root = findCall(state, callId);
  if (!canCommitRootResponse(state, callId, root)) {
    return reject(state, "root_response_not_allowed");
  }
  if (!isBoundedText(response, policy.limits.maxResponseChars)) {
    return reject(state, "invalid_command");
  }
  return commit(
    {
      ...state,
      phase: "completed",
      activeCallId: null,
      rootResponse:
        policy.authority.terminalTextMode === "exact"
          ? response
          : response.trim(),
      capabilitySelectionSupervision:
        resetRoleCapabilitySelectionSupervisionState(),
      calls: replaceCall(state.calls, {
        ...root,
        status: "completed",
      }),
    },
    { type: "root_response_committed", callId },
  );
}

function hasExistingCanonicalRoot(state: RoleCallState): boolean {
  return state.phase !== "empty" || state.rootCallId !== null;
}

function canCommitRootResponse(
  state: RoleCallState,
  callId: string,
  root: RoleCallFrame | undefined,
): root is RoleCallFrame {
  if (state.phase !== "running") return false;
  if (callId !== state.rootCallId) return false;
  if (state.activeCallId !== callId) return false;
  if (root?.roleId !== RUNTIME_ROOT_ROLE_ID) return false;
  return root.status === "active";
}
