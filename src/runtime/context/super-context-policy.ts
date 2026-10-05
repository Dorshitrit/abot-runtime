import {
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type ExecutionPolicyAuthoritySnapshot,
} from "../orchestration/role-calls/contracts.js";

/** Opt-in follows the frozen registered contract, never a model or role name. */
export function hasSuperContextContract(
  authority: ExecutionPolicyAuthoritySnapshot,
  contractId: string,
): boolean {
  const expected = SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT;
  if (authority.id !== expected.id) return false;
  if (authority.version !== expected.version) return false;
  if (authority.definitionHash !== expected.definitionHash) return false;
  if (authority.rootContractId !== expected.rootContractId) return false;
  if (authority.modelWorkPlanAuthority !== expected.modelWorkPlanAuthority)
    return false;
  if ((authority.terminalTextMode ?? "normalized") !== "normalized")
    return false;
  if (
    !hasOrderedAuthorityValues(
      authority.availableSubordinateContractIds,
      expected.availableSubordinateContractIds,
    )
  )
    return false;
  if (
    !hasOrderedAuthorityValues(
      authority.capabilityAuthorities,
      expected.capabilityAuthorities,
    )
  )
    return false;
  switch (contractId) {
    case "supervisor":
    case "delegated.planner":
    case "delegated.worker":
    case "delegated.reviewer":
      return true;
    default:
      return false;
  }
}

function hasOrderedAuthorityValues(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((value, index) => value === expected[index]);
}
