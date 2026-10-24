import type { ExecutionPolicyAuthoritySnapshot } from "../orchestration/role-calls/index.js";

/** The frozen request policy owns implicit payload evidence collection. */
export function allowsAutomaticPayloadArtifactLoading(
  authority: ExecutionPolicyAuthoritySnapshot | undefined,
): boolean {
  if (authority?.id === "execution-agent-v1") return false;
  return true;
}
