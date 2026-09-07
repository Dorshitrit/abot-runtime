import type {
  RoleCallLedgerCommand,
  RoleCallPolicy,
  RoleCallState,
  RoleCallValidationIssue,
} from "./contracts.js";

export type RoleActivationBudgetSnapshot = Readonly<{
  totalAcceptedActivations: number;
  highestCallActivationCount: number;
  maximumAcceptedActivationsPerCall: number;
}>;

export function resolveRoleActivationBudget(
  state: RoleCallState,
  policy: RoleCallPolicy,
): RoleActivationBudgetSnapshot {
  const activationCounts = state.calls.map((call) => call.activationCount);
  return Object.freeze({
    totalAcceptedActivations: activationCounts.reduce(
      (total, count) => total + count,
      0,
    ),
    highestCallActivationCount: activationCounts.reduce(
      (highest, count) => Math.max(highest, count),
      0,
    ),
    maximumAcceptedActivationsPerCall:
      policy.limits.maxCalls + policy.limits.maxCapabilityExecutions + 1,
  });
}

export function findRoleActivationBudgetIssue(
  state: RoleCallState,
  policy: RoleCallPolicy,
): RoleCallValidationIssue | undefined {
  const budget = resolveRoleActivationBudget(state, policy);
  const overBudgetCall = state.calls.find(
    (call) => call.activationCount > budget.maximumAcceptedActivationsPerCall,
  );
  if (!overBudgetCall) return undefined;
  return Object.freeze({
    code: "role_activation_limit_exceeded",
    path: `state.calls.${overBudgetCall.callId}.activationCount`,
  });
}

/**
 * Reserves the next activation before starting work that must later resume the
 * same call. Settlements and child returns consume an earlier reservation and
 * are therefore never rejected after their external work has completed.
 */
export function findRoleActivationReservationIssue(
  state: RoleCallState,
  policy: RoleCallPolicy,
  command: RoleCallLedgerCommand,
): RoleCallValidationIssue | undefined {
  const callId = resolveActivationReservationCallId(command);
  if (!callId) return undefined;
  const call = state.calls.find((candidate) => candidate.callId === callId);
  if (!call) return undefined;
  const { maximumAcceptedActivationsPerCall } = resolveRoleActivationBudget(
    state,
    policy,
  );
  if (call.activationCount < maximumAcceptedActivationsPerCall) {
    return undefined;
  }
  return Object.freeze({
    code: "role_activation_limit_exceeded",
    path: `state.calls.${call.callId}.activationCount`,
  });
}

function resolveActivationReservationCallId(
  command: RoleCallLedgerCommand,
): string | undefined {
  switch (command.type) {
    case "open_child":
      return command.callerCallId;
    case "begin_capability_execution":
    case "begin_capability_batch":
    case "update_capability_scope":
    case "reconsider_capability_selection":
    case "begin_memory_recall":
      return command.callId;
    default:
      return undefined;
  }
}
