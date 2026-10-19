import type { ToolAvailabilityEntry } from "../../../capabilities/tool-types.js";
import { knowledgeSkillWriteOperations } from "../../capabilities/knowledge-skills/write-contract.js";
import { hasSuperContextContract } from "../../context/super-context-policy.js";
import type { ExecutionPolicyAuthoritySnapshot, RoleCallFrame, RoleCallLedgerHead } from "../role-calls/index.js";
import type { WorkerCapabilityAdapter, WorkerCapabilityDescriptor } from "./contracts.js";

const skillAuthoringCapabilityIds: ReadonlySet<string> = new Set(
  knowledgeSkillWriteOperations.map(({ operationId }) => operationId),
);

export function isSupervisorSkillWriteCapabilityId(capabilityId: string): boolean {
  return skillAuthoringCapabilityIds.has(capabilityId);
}

export function projectSupervisorWorkerCapabilityDescriptors(params: {
  authority: ExecutionPolicyAuthoritySnapshot;
  descriptors: readonly WorkerCapabilityDescriptor[];
}): readonly WorkerCapabilityDescriptor[] {
  if (!hasSuperContextContract(params.authority, "supervisor")) return params.descriptors;
  return Object.freeze(params.descriptors.filter((descriptor) =>
    !isSupervisorSkillWriteCapabilityId(descriptor.capabilityId),
  ));
}

/** Descriptions and selectable descriptors obey the same write ownership. */
export function projectSupervisorWorkerCapabilityBriefEntries(params: {
  authority: ExecutionPolicyAuthoritySnapshot;
  entries: readonly ToolAvailabilityEntry[] | undefined;
}): readonly ToolAvailabilityEntry[] | undefined {
  if (!hasSuperContextContract(params.authority, "supervisor")) return params.entries;
  if (params.entries === undefined) return undefined;
  return Object.freeze(params.entries.filter(({ operationId }) =>
    !isSupervisorSkillWriteCapabilityId(operationId),
  ));
}

/** The same boundary applies before execution and before approval restoration. */
export function projectSupervisorSkillCapabilityAdapters<TContext>(params: {
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  adapters: readonly WorkerCapabilityAdapter<TContext>[];
}): readonly WorkerCapabilityAdapter<TContext>[] {
  if (!hasSuperContextContract(params.head.policy.authority, "supervisor")) return params.adapters;
  // Preserve malformed entries for the existing adapter validation boundary.
  if (!Array.isArray(params.adapters)) return params.adapters;
  if (isSupervisorRootCapabilityCall(params.head, params.call)) {
    return Object.freeze(params.adapters.filter((adapter) =>
      hasMalformedCapabilityIdentity(adapter) ||
      isSupervisorSkillWriteCapabilityId(adapter.descriptor.capabilityId),
    ));
  }
  if (params.call.roleId !== "worker") return params.adapters;
  return Object.freeze(params.adapters.filter((adapter) =>
    hasMalformedCapabilityIdentity(adapter) ||
    !isSupervisorSkillWriteCapabilityId(adapter.descriptor.capabilityId),
  ));
}

function isSupervisorRootCapabilityCall(head: RoleCallLedgerHead, call: RoleCallFrame): boolean {
  if (call.callId !== head.state.rootCallId) return false;
  return call.parentCallId === null;
}

function hasMalformedCapabilityIdentity<TContext>(adapter: WorkerCapabilityAdapter<TContext>): boolean {
  return typeof adapter?.descriptor?.capabilityId !== "string";
}
