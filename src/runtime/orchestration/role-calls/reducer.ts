import {
  ROLE_CALL_LEDGER_CONTRACT_VERSION,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type RoleCallPolicy,
  type RoleCallPolicyInput,
  type RoleCallState,
  type RoleCallTransitionResult,
  type RoleCallValidationIssue,
} from "./contracts.js";
import {
  validateRoleCallPolicy,
  validateRoleCallState,
} from "./candidate-validation.js";
import { decodeRoleCallCommand } from "./command-decoder.js";
import { dispatchRoleCallCommand } from "./command-dispatch.js";
import { findRoleActivationReservationIssue } from "./activation-budget.js";
import { createInitialRoleCapabilitySelectionSupervisionState } from "./capability-selection-supervision.js";
import { issueInitialRoleCapabilitySelectionSupervisionState } from "./capability-selection-supervision-issuance.js";
import { createInitialRoleOperationSupervisionState } from "./operation-supervision.js";
import { reject, seal } from "./reducer-primitives.js";

export { hasRoleCallCapabilityAuthority } from "./candidate-validation.js";

export function createInitialRoleCallState(requestId: string): RoleCallState {
  const state: RoleCallState = seal({
    contractVersion: ROLE_CALL_LEDGER_CONTRACT_VERSION,
    requestId,
    phase: "empty",
    rootCallId: null,
    activeCallId: null,
    callSequence: 0,
    resultSequence: 0,
    capabilityExecutionSequence: 0,
    calls: [],
    results: [],
    plans: [],
    capabilityExecutions: [],
    operationSupervision: createInitialRoleOperationSupervisionState(),
    capabilitySelectionSupervision:
      createInitialRoleCapabilitySelectionSupervisionState(),
    rootResponse: null,
  });
  if (!issueInitialRoleCapabilitySelectionSupervisionState(state)) {
    throw new Error(
      "role_call_capability_selection_supervision_initial_issuance_invalid",
    );
  }
  return state;
}

export function applyRoleCallCommand(
  state: RoleCallState,
  commandInput: unknown,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const policyIssues = validateRoleCallPolicy(policy);
  if (policyIssues.length > 0) {
    return reject(state, "invalid_policy", policyIssues);
  }
  const stateIssues = validateRoleCallState(state, policy);
  if (stateIssues.length > 0) {
    return reject(state, "invalid_current_state", stateIssues);
  }
  const command = decodeRoleCallCommand(commandInput);
  if (!command.ok) {
    return reject(state, command.code);
  }
  const transition = dispatchRoleCallCommand(state, command.value, policy);
  if (!transition.ok) return transition;
  const reservationIssue = findRoleActivationReservationIssue(
    state,
    policy,
    command.value,
  );
  if (reservationIssue) {
    return reject(state, "role_activation_limit_exceeded", [reservationIssue]);
  }
  return transition;
}

export function validateRoleCallCandidate(params: {
  state: RoleCallState;
  policy: RoleCallPolicy;
}): readonly RoleCallValidationIssue[] {
  const policyIssues = validateRoleCallPolicy(params.policy);
  return policyIssues.length > 0
    ? policyIssues
    : validateRoleCallState(params.state, params.policy);
}

export function sealRoleCallPolicy(
  policy: RoleCallPolicyInput,
): RoleCallPolicy {
  return seal(
    structuredClone({
      ...policy,
      authority: policy.authority ?? SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
    }),
  );
}
