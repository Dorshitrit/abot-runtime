import type { WorkerCapabilityDescriptor } from "../../orchestration/worker-capabilities/index.js";
import {
  projectWorkerCapabilityAffordances,
  type WorkerCapabilityAffordance,
} from "./capability-affordances.js";

export const WORKER_CAPABILITY_CATALOG_COLUMNS = Object.freeze([
  "capabilityId",
  "summary",
  "effect",
  "catalogGroups",
] as const);

export type WorkerCapabilityCatalogEntry = readonly [
  capabilityId: string,
  summary: string,
  effect: WorkerCapabilityDescriptor["effect"],
  catalogGroups: readonly string[],
];

type WorkerCapabilityCatalogPromptPayload =
  | Readonly<{
      availableCapabilityCatalog: Readonly<{
        columns: typeof WORKER_CAPABILITY_CATALOG_COLUMNS;
        entries: readonly WorkerCapabilityCatalogEntry[];
      }>;
    }>
  | Readonly<{
      availableCapabilities: readonly WorkerCapabilityAffordance[];
    }>;

export type WorkerCapabilityCatalogProjection = Readonly<{
  kind: "grouped" | "flat";
  promptPayload: WorkerCapabilityCatalogPromptPayload;
  groupCount: number;
  membershipCount: number;
  projectedCharacterCount: number;
  groupedCharacterCount: number;
  flatCharacterCount: number;
}>;

export function projectWorkerCapabilitySelectionCatalog(
  capabilities: readonly WorkerCapabilityDescriptor[],
): WorkerCapabilityCatalogProjection {
  const flatPayload = Object.freeze({
    availableCapabilities: projectWorkerCapabilityAffordances(capabilities),
  });
  const byGroupId = new Map<string, Set<string>>();
  for (const capability of capabilities) {
    for (const groupId of capability.catalogGroups ?? []) {
      const members = byGroupId.get(groupId) ?? new Set();
      members.add(capability.capabilityId);
      byGroupId.set(groupId, members);
    }
  }
  const entries = Object.freeze(
    [...capabilities]
      .sort(({ capabilityId: left }, { capabilityId: right }) =>
        compareIds(left, right),
      )
      .map(({ capabilityId, summary, effect, catalogGroups }) =>
        Object.freeze([
          capabilityId,
          summary,
          effect,
          Object.freeze([...(catalogGroups ?? [])].sort(compareIds)),
        ] as const),
      ),
  );
  const groupedPayload = Object.freeze({
    availableCapabilityCatalog: Object.freeze({
      columns: WORKER_CAPABILITY_CATALOG_COLUMNS,
      entries,
    }),
  });
  const flatCharacterCount = JSON.stringify(flatPayload).length;
  const groupedCharacterCount = JSON.stringify(groupedPayload).length;
  const coveredCapabilityIds = new Set(
    [...byGroupId.values()].flatMap((members) => [...members]),
  );
  const grouped =
    coveredCapabilityIds.size === capabilities.length &&
    groupedCharacterCount < flatCharacterCount;
  const promptPayload = grouped ? groupedPayload : flatPayload;
  return Object.freeze({
    kind: grouped ? "grouped" : "flat",
    promptPayload,
    groupCount: byGroupId.size,
    membershipCount: entries.reduce(
      (total, [, , , catalogGroups]) => total + catalogGroups.length,
      0,
    ),
    projectedCharacterCount: JSON.stringify(promptPayload).length,
    groupedCharacterCount,
    flatCharacterCount,
  });
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
