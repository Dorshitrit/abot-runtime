import {
  projectCapabilityCatalogGroups,
  projectCapabilityScope,
  type CapabilityCatalogGroup,
  type CapabilityDescriptor,
} from "../../orchestration/capability-adapters/index.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import {
  resolveRequestWorkerCapabilities,
  type RequestExecutionScope,
} from "../../request/execution-scope.js";

/** One decision-local capability offer shared by guidance loading and input. */
export type ExecutionCapabilityScope = Readonly<{
  capabilities: readonly CapabilityDescriptor[];
  capabilityCatalogGroups: readonly CapabilityCatalogGroup[];
  activeCapabilityCatalogGroupIds: readonly string[] | null;
  knownGroupIds: readonly string[];
  remainingExecutions: number;
  capabilityScopeAction: "open" | "extend" | null;
}>;

export function resolveExecutionCapabilityScope(
  request: RequestExecutionScope,
  options: Readonly<{ head: RoleCallLedgerHead; call: RoleCallFrame }>,
): ExecutionCapabilityScope {
  assertExecutionAgentCanonicalSource(request, options.head, options.call);
  const allCapabilities =
    resolveRequestWorkerCapabilities(request).provider.getDescriptors();
  const capabilityCatalogGroups =
    projectCapabilityCatalogGroups(allCapabilities);
  const activeCapabilityCatalogGroupIds = options.call.workerCapabilityScope
    ? Object.freeze([...options.call.workerCapabilityScope.catalogGroupIds])
    : null;
  const remainingExecutions =
    options.head.policy.limits.maxCapabilityExecutions -
    options.head.state.capabilityExecutions.length;
  const capabilities = canOfferScopedCapabilities(
    activeCapabilityCatalogGroupIds,
    remainingExecutions,
  )
    ? projectCapabilityScope({
        entries: allCapabilities,
        scope: options.call.workerCapabilityScope,
        descriptorOf: (entry) => entry,
      }).entries
    : Object.freeze([]);
  const knownGroupIds = Object.freeze(
    capabilityCatalogGroups.map(({ groupId }) => groupId),
  );
  return Object.freeze({
    capabilities,
    capabilityCatalogGroups,
    activeCapabilityCatalogGroupIds,
    knownGroupIds,
    remainingExecutions,
    capabilityScopeAction: resolveCapabilityScopeAction(
      activeCapabilityCatalogGroupIds,
      knownGroupIds,
      remainingExecutions,
    ),
  });
}

export function assertExecutionAgentCanonicalSource(
  request: RequestExecutionScope,
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): void {
  if (
    head.state.requestId !== request.requestId ||
    head.state.phase !== "running" ||
    head.state.rootCallId !== call.callId ||
    head.state.activeCallId !== call.callId ||
    call.parentCallId !== null ||
    call.status !== "active"
  ) {
    throw new Error("execution_agent_head_invalid");
  }
}

function canOfferScopedCapabilities(
  activeGroupIds: readonly string[] | null,
  remainingExecutions: number,
): boolean {
  if (activeGroupIds === null) return false;
  return remainingExecutions > 0;
}

function resolveCapabilityScopeAction(
  activeGroupIds: readonly string[] | null,
  knownGroupIds: readonly string[],
  remainingExecutions: number,
): "open" | "extend" | null {
  if (remainingExecutions <= 0) return null;
  if (knownGroupIds.length === 0) return null;
  if (activeGroupIds === null) return "open";
  if (knownGroupIds.some((groupId) => !activeGroupIds.includes(groupId)))
    return "extend";
  return null;
}
