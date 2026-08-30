import { resetRoleCapabilitySelectionSupervisionState } from "../capability-selection-supervision.js";
import type {
  EstablishRoleCallWorkingDirectoryCommand,
  RoleCallFrame,
  RoleCallPolicy,
  RoleCallState,
  RoleCallTransitionResult,
  RoleCallWorkerCapabilityScope,
  UpdateRoleCapabilityScopeCommand,
} from "../contracts.js";
import { commit, reject } from "../reducer-primitives.js";
import { parseRoleCallWorkerCapabilityScope } from "../worker-capability-scope.js";
import { normalizeEstablishedRoleCallWorkingDirectory } from "../working-directory.js";
import { findActiveCapabilityCaller } from "./active-capability-caller.js";
import { replaceCall } from "./call-frame-state.js";

export function establishWorkingDirectory(
  state: RoleCallState,
  command: EstablishRoleCallWorkingDirectoryCommand,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const { callId, invocationAttempt, workingDirectory } = command;
  const call = findActiveCapabilityCaller({ state, policy, callId });
  if (!canEstablishWorkingDirectory(call, invocationAttempt)) {
    return reject(state, "working_directory_establishment_invalid");
  }
  const normalized =
    normalizeEstablishedRoleCallWorkingDirectory(workingDirectory);
  if (!normalized) {
    return reject(state, "working_directory_establishment_invalid");
  }
  return commit(
    {
      ...state,
      capabilitySelectionSupervision:
        resetRoleCapabilitySelectionSupervisionState(),
      calls: replaceCall(state.calls, {
        ...call,
        workingDirectory: normalized,
      }),
    },
    { type: "working_directory_established", callId },
  );
}

export function updateCapabilityScope(
  state: RoleCallState,
  command: UpdateRoleCapabilityScopeCommand,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const { callId, invocationAttempt, mode, catalogGroupIds } = command;
  const call = findActiveCapabilityCaller({ state, policy, callId });
  if (!call) {
    return reject(state, "capability_caller_invalid");
  }
  if (call.activationCount !== invocationAttempt) {
    return reject(state, "capability_invocation_mismatch");
  }

  const requestedScope = parseRoleCallWorkerCapabilityScope({
    catalogGroupIds,
  });
  if (!requestedScope) {
    return reject(state, "invalid_command");
  }
  const nextScope = resolveCapabilityScopeUpdate(
    mode,
    call.workerCapabilityScope,
    requestedScope,
  );
  if (!nextScope) {
    return reject(state, "capability_scope_update_invalid");
  }

  return commit(
    {
      ...state,
      capabilitySelectionSupervision:
        resetRoleCapabilitySelectionSupervisionState(),
      calls: replaceCall(state.calls, {
        ...call,
        workerCapabilityScope: nextScope,
        activationCount: call.activationCount + 1,
      }),
    },
    {
      type: "capability_scope_updated",
      callId,
      mode,
      catalogGroupIds: nextScope.catalogGroupIds,
    },
  );
}

function canEstablishWorkingDirectory(
  call: RoleCallFrame | undefined,
  invocationAttempt: number,
): call is RoleCallFrame {
  if (!call) return false;
  if (call.activationCount !== invocationAttempt) return false;
  return call.workingDirectory === undefined;
}

function resolveCapabilityScopeUpdate(
  mode: UpdateRoleCapabilityScopeCommand["mode"],
  currentScope: RoleCallWorkerCapabilityScope | undefined,
  requestedScope: RoleCallWorkerCapabilityScope,
): RoleCallWorkerCapabilityScope | undefined {
  if (mode === "open" && currentScope !== undefined) return undefined;
  if (mode === "open") return requestedScope;
  if (!currentScope) return undefined;
  if (hasOverlappingCapabilityCatalogGroups(currentScope, requestedScope)) {
    return undefined;
  }
  return parseRoleCallWorkerCapabilityScope({
    catalogGroupIds: [
      ...currentScope.catalogGroupIds,
      ...requestedScope.catalogGroupIds,
    ],
  });
}

function hasOverlappingCapabilityCatalogGroups(
  currentScope: RoleCallWorkerCapabilityScope,
  requestedScope: RoleCallWorkerCapabilityScope,
): boolean {
  return requestedScope.catalogGroupIds.some((groupId) =>
    currentScope.catalogGroupIds.includes(groupId),
  );
}
