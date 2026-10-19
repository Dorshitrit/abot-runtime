import type { ExecutionPolicyAuthoritySnapshot } from "../orchestration/role-calls/index.js";
import type { RuntimeDelegateRoleId } from "../orchestration/roles.js";
import { projectWorkerCapabilityCatalogGroups } from "../orchestration/worker-capabilities/index.js";
import type { WorkerCapabilityDescriptor } from "../orchestration/worker-capabilities/contracts.js";
import {
  isSupervisorSkillWriteCapabilityId,
  projectSupervisorWorkerCapabilityDescriptors,
} from "../orchestration/worker-capabilities/supervisor-skill-authority.js";
import { hasSuperContextContract } from "../context/super-context-policy.js";

/** Capture both role projections from the same request-session descriptor read. */
export function captureRootCapabilityCatalog(params: {
  authority: ExecutionPolicyAuthoritySnapshot;
  roleIds: readonly RuntimeDelegateRoleId[];
  getDescriptors: () => readonly WorkerCapabilityDescriptor[];
}) {
  const descriptors = canCaptureRootCapabilityCatalog(params.authority, params.roleIds)
    ? params.getDescriptors() : [];
  const availableWorkerCapabilityCatalog = projectWorkerCapabilityCatalogGroups(
    projectSupervisorWorkerCapabilityDescriptors({ authority: params.authority, descriptors }),
  );
  const availableSkillWriteOperationIds = hasSuperContextContract(params.authority, "supervisor")
    ? descriptors.map(({ capabilityId }) => capabilityId).filter(isSupervisorSkillWriteCapabilityId) : [];
  return Object.freeze({ availableWorkerCapabilityCatalog,
    availableSkillWriteOperationIds: Object.freeze(availableSkillWriteOperationIds) });
}

function canCaptureRootCapabilityCatalog(
  authority: ExecutionPolicyAuthoritySnapshot,
  roleIds: readonly RuntimeDelegateRoleId[],
): boolean {
  if (authority.capabilityAuthorities.includes("root")) return true;
  if (!roleIds.includes("worker")) return false;
  return authority.capabilityAuthorities.includes("worker");
}
