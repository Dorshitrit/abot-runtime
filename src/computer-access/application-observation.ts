import type { SystemApplicationCatalog } from "./application-catalog.js";
import type { SystemApplication, SystemTarget } from "./contracts.js";
import { enforcePluginResultByteBudget, type ToolResultBudget, type ToolImplementationOutput } from "../plugin-sdk/index.js";
import { formatSystemApplicationSummary, type SystemApplicationObservationData } from "./application-summary.js";
import { projectSystemApplicationResultForBudget } from "./application-result-budget.js";

export type SystemApplicationSelection = Readonly<{
  observedMatches: number;
  omittedMatches: number;
  applications: readonly SystemApplication[];
}>;

export function selectSystemApplications(
  catalog: SystemApplicationCatalog,
  query: string,
  limit: number,
): SystemApplicationSelection {
  const matches = catalog.applications.filter((application) =>
    matchesApplicationQuery(application.name, application.id, query),
  );
  return {
    observedMatches: matches.length,
    omittedMatches: Math.max(0, matches.length - limit),
    applications: matches.slice(0, limit),
  };
}

export function systemApplicationObservation(
  target: SystemTarget,
  catalog: SystemApplicationCatalog,
  query: string,
  limit: number,
  selection = selectSystemApplications(catalog, query, limit),
) {
  const data: SystemApplicationObservationData = {
    target: target.id,
    transport: target.transport,
    absenceConclusionSupported: false,
    completenessMeaning: "declared_catalog_sources_only",
    catalogScope: catalog.scope,
    catalogComplete: catalog.complete,
    ...selection,
  };
  return { output: formatSystemApplicationSummary(data), data };
}

/** Optional executable detail must not displace the selected catalog identities. */
export function systemApplicationResult(
  target: SystemTarget,
  catalog: SystemApplicationCatalog,
  query: string,
  limit: number,
  selection: SystemApplicationSelection,
  budget?: ToolResultBudget,
) {
  const { output, data } = systemApplicationObservation(target, catalog, query, limit, selection);
  const result: ToolImplementationOutput = {
    ok: true, output, producedNewInformation: true,
    data: { ...data, observationMeta: { kind: "volatile_external", carryPolicy: "never" } },
  };
  return enforcePluginResultByteBudget(projectSystemApplicationResultForBudget(result, budget), budget);
}

function matchesApplicationQuery(
  name: string,
  id: string,
  query: string,
): boolean {
  if (name.toLowerCase().includes(query)) return true;
  return id.toLowerCase().includes(query);
}
