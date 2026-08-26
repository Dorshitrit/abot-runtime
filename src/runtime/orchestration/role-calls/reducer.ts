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
import { reject, seal } from "./reducer-primitives.js";

export { hasRoleCallCapabilityAuthority } from "./candidate-validation.js";

export function createInitialRoleCallState(requestId: string): RoleCallState {
  return seal({
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
    rootResponse: null,
  });
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
  return dispatchRoleCallCommand(state, command.value, policy);
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
