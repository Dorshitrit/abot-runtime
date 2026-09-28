import { isDeepStrictEqual } from "node:util";
import type { RoleCallLedgerCheckpoint } from "./checkpoint-contract.js";
import type { RoleCallPolicy, RoleCallState } from "./contracts.js";
import { seal } from "./reducer-primitives.js";
import { validateRoleCallCandidate } from "./reducer.js";
import { issueInitialRoleCapabilitySelectionSupervisionState } from "./capability-selection-supervision-issuance.js";
import { restoreRoleOperationSupervisionIssuance } from "./operation-supervision-issuance.js";

/** Hydrate only an admitted, parked capability; no model or reducer command replay. */
export function restoreCheckpointState(
  checkpoint: RoleCallLedgerCheckpoint,
  requestId: string,
  policy: RoleCallPolicy,
): RoleCallState {
  if (!isCheckpointEnvelope(checkpoint))
    throw new Error("role_call_checkpoint_invalid");
  if (!hasCheckpointRequestIdentity(checkpoint, requestId))
    throw new Error("role_call_checkpoint_request_mismatch");
  if (!hasCheckpointPolicy(checkpoint, policy))
    throw new Error("role_call_checkpoint_policy_mismatch");
  const state = seal(structuredClone(checkpoint.state));
  if (!isParkedCapabilityState(state))
    throw new Error("role_call_checkpoint_not_parked");
  if (!issueInitialRoleCapabilitySelectionSupervisionState(state))
    throw new Error("role_call_checkpoint_selection_issuance_invalid");
  restoreRoleOperationSupervisionIssuance(state);
  if (!isCheckpointCandidateValid(state, policy))
    throw new Error("role_call_checkpoint_state_invalid");
  if (!hasConsistentCheckpointRevision(checkpoint.revision, state))
    throw new Error("role_call_checkpoint_revision_inconsistent");
  return state;
}

function isCheckpointEnvelope(value: RoleCallLedgerCheckpoint): boolean {
  if (!value || typeof value !== "object") return false;
  if (value.kind !== "role_call_checkpoint_v1") return false;
  if (!Number.isSafeInteger(value.revision)) return false;
  return value.revision > 0;
}

function isParkedCapabilityState(state: RoleCallState): boolean {
  if (state.phase !== "running") return false;
  if (!Array.isArray(state.calls)) return false;
  if (!Array.isArray(state.capabilityExecutions)) return false;
  if (!state.capabilitySelectionSupervision) return false;
  if (!state.operationSupervision) return false;
  if (!Array.isArray(state.operationSupervision.interventions)) return false;
  const call = state.calls.find((entry) => entry.callId === state.activeCallId);
  if (call?.status !== "waiting_for_capability") return false;
  return state.capabilityExecutions.some(
    (execution) =>
      execution.callId === call.callId && execution.status === "running",
  );
}

function hasCheckpointRequestIdentity(
  checkpoint: RoleCallLedgerCheckpoint,
  requestId: string,
): boolean {
  return checkpoint.state?.requestId === requestId;
}

function hasCheckpointPolicy(
  checkpoint: RoleCallLedgerCheckpoint,
  policy: RoleCallPolicy,
): boolean {
  return isDeepStrictEqual(checkpoint.policy, policy);
}

function isCheckpointCandidateValid(
  state: RoleCallState,
  policy: RoleCallPolicy,
): boolean {
  try {
    return validateRoleCallCandidate({ state, policy }).length === 0;
  } catch {
    return false;
  }
}

function hasConsistentCheckpointRevision(
  revision: number,
  state: RoleCallState,
): boolean {
  const begins = new Set(
    state.capabilityExecutions.map(executionActivationIdentity),
  );
  const settlements = new Set(
    state.capabilityExecutions
      .filter((entry) => entry.status === "settled")
      .map(executionActivationIdentity),
  );
  const minimumCommits =
    state.calls.length + state.results.length + begins.size + settlements.size;
  if (revision < minimumCommits) return false;
  return state.results.every(
    (result) =>
      result.receipt === undefined || result.receipt.sourceRevision < revision,
  );
}

function executionActivationIdentity(
  execution: RoleCallState["capabilityExecutions"][number],
): string {
  return JSON.stringify([execution.callId, execution.invocationAttempt]);
}
