import type { BasketSource } from "../../information-basket/contracts.js";
import { isBasketSourceReady } from "../../information-basket/readiness.js";
import {
  AUTHORING_CONTEXT_LIMITS as limits, type AuthoringContextDependencies,
  type AuthoringContextInput, type ReferenceSection, type ReferenceEntry,
} from "./contracts.js";
import { boundEntries, inactiveSection, requireSource } from "./projection.js";

export type ResourceIndexEntry = Readonly<{
  sourceId: string; expectedRevision: number; displayName: string;
  status: "ready"; indexedAt: string | null; sizeBytes: number | null; chunkCount: number;
  contentStatus: "not_loaded";
}>;
export type ResourceIndex = ReferenceSection<ResourceIndexEntry> & Readonly<{ nonReadyCount?: number }>;

function indexEntry(source: BasketSource): ResourceIndexEntry {
  return {
    sourceId: source.sourceId, expectedRevision: source.revision, displayName: source.displayName,
    status: "ready", indexedAt: source.indexedAt,
    sizeBytes: source.sizeBytes, chunkCount: source.chunkCount, contentStatus: "not_loaded",
  };
}

export async function captureResourceIndex(
  resources: AuthoringContextDependencies["resources"], input: Pick<AuthoringContextInput, "resourcesAccess" | "abortSignal">,
): Promise<ResourceIndex> {
  return captureProjectedResourceIndex(resources, input, indexEntry, limits.resourceIndexCharacters);
}

export function projectPlanningResourceIndex(resources: ResourceIndex) {
  if (resources.status !== "available") return resources;
  return boundEntries(resources.entries.map(source => ({
    sourceId: source.sourceId, expectedRevision: source.expectedRevision, displayName: source.displayName,
    status: "ready" as const, contentStatus: "not_loaded" as const,
  })), limits.resourceIndex, limits.planningResourceCharacters,
  { availableCount: resources.availableCount, scannedCount: resources.scannedCount, selection: resources.selection });
}

async function captureProjectedResourceIndex<T extends ReferenceEntry>(
  resources: AuthoringContextDependencies["resources"], input: Pick<AuthoringContextInput, "resourcesAccess" | "abortSignal">,
  project: (source: BasketSource) => T, characterBudget: number,
): Promise<ReferenceSection<T> & Readonly<{ nonReadyCount?: number }>> {
  if (input.resourcesAccess === "blocked") return { ...inactiveSection("blocked", "request_tool_policy_denied"), entries: [] };
  if (!resources) return { ...inactiveSection("unavailable", "resources_service_not_configured"), entries: [] };
  return requireSource("resource_index", async () => {
    const view = await resources.list({ verifySources: false, abortSignal: input.abortSignal });
    if (!view.settings.enabled) return { ...inactiveSection("disabled", "resources_disabled"), entries: [] };
    const ready = view.sources.filter(isBasketSourceReady)
      .sort((left, right) => (right.indexedAt ?? "").localeCompare(left.indexedAt ?? "") || left.sourceId.localeCompare(right.sourceId));
    if (ready.length && !resources.isReady()) return {
      ...inactiveSection("unavailable", "resources_retrieval_not_ready"), entries: [],
      scannedCount: view.sources.length, nonReadyCount: view.sources.length - ready.length,
    };
    const section = boundEntries(ready.map(project), limits.resourceIndex, characterBudget,
      { availableCount: ready.length, scannedCount: view.sources.length, selection: "ready_registered_index_metadata_only_latest_indexed" });
    const noReadyIndexes = view.sources.length > 0 && ready.length === 0;
    return {
      ...section, ...(noReadyIndexes ? { status: "unavailable" as const, reason: "no_ready_indexed_sources" } : {}),
      nonReadyCount: view.sources.length - ready.length,
    };
  });
}
