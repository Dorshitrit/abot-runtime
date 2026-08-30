import {
  projectRoleCallDependencyResults,
  type RoleCallDependencyResult,
  type RoleCallFrame,
  type RoleCallLedgerHead,
} from "../../role-calls/index.js";

export function bindCapabilityDependencyResults(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
  supplied: readonly RoleCallDependencyResult[] | undefined,
): readonly RoleCallDependencyResult[] {
  const canonical = projectRoleCallDependencyResults(head, call);
  if (supplied === undefined) return canonical;
  if (!areCanonicalDependencyResults(supplied, canonical)) {
    throw new Error("worker_dependency_results_invalid");
  }
  return Object.freeze([...supplied]);
}

function areCanonicalDependencyResults(
  supplied: readonly RoleCallDependencyResult[],
  canonical: readonly RoleCallDependencyResult[],
): boolean {
  if (!Array.isArray(supplied)) return false;
  if (!Object.isFrozen(supplied)) return false;
  if (supplied.length !== canonical.length) return false;
  return supplied.every((result, index) =>
    matchesCanonicalDependencyResult(result, canonical[index]),
  );
}

function matchesCanonicalDependencyResult(
  result: RoleCallDependencyResult,
  expected: RoleCallDependencyResult | undefined,
): boolean {
  if (!Object.isFrozen(result)) return false;
  if (!expected) return false;
  if (result.resultRef !== expected.resultRef) return false;
  if (result.producerCallId !== expected.producerCallId) return false;
  if (result.roleId !== expected.roleId) return false;
  if (result.outcome !== expected.outcome) return false;
  return result.summary === expected.summary;
}
