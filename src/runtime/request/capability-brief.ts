import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";
import type { WorkerCapabilityCatalogGroup } from "../orchestration/worker-capabilities/index.js";
import type { RequestWorkerCapabilities } from "./execution-scope.js";

/** Reuses the request registry's facts, bounded by its offered capability set. */
export function resolveRequestCapabilityBriefEntries(
  capabilities: RequestWorkerCapabilities,
  groups: readonly WorkerCapabilityCatalogGroup[],
): readonly ToolAvailabilityEntry[] | undefined {
  if (groups.length === 0) return undefined;
  const availableTools = capabilities.provider.getAvailableTools?.();
  if (availableTools === undefined) return undefined;
  const groupIds = new Set(groups.map((group) => group.groupId));
  const offered = capabilities.provider
    .getDescriptors()
    .filter((descriptor) =>
      (descriptor.catalogGroups ?? ["other"]).some((id) => groupIds.has(id)),
    );
  const byOperation = new Map(
    availableTools.map((entry) => [entry.operationId, entry]),
  );
  const entries: ToolAvailabilityEntry[] = [];
  for (const descriptor of offered) {
    const entry = byOperation.get(descriptor.capabilityId);
    if (entry === undefined) return undefined;
    entries.push(
      Object.freeze({
        ...entry,
        catalogGroups: Object.freeze(
          (descriptor.catalogGroups ?? ["other"]).filter((id) =>
            groupIds.has(id),
          ),
        ),
      }),
    );
  }
  return Object.freeze(entries);
}
