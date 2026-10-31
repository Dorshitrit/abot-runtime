import { hasSuperContextContract } from "../context/super-context-policy.js";
import type { ExecutionPolicyAuthoritySnapshot } from "../orchestration/role-calls/index.js";

/** The frozen SUPER contract owns the selected target's authoring coverage. */
export function preservesFullSuperPayloadTargetContext(
  authority?: ExecutionPolicyAuthoritySnapshot,
): boolean {
  if (!authority) return false;
  return hasSuperContextContract(authority, "delegated.worker");
}
