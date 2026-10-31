import type { ExecutionPolicyAuthoritySnapshot } from "../orchestration/role-calls/contracts.js";

/** One frozen-policy gate for EA history capture, preparation and payload consumers. */
export function hasExecutionHistoryAuthority(
  authority: ExecutionPolicyAuthoritySnapshot | undefined,
): boolean {
  return authority?.id === "execution-agent-v1";
}
