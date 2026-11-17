import type { SystemApplicationCatalogScope } from "./application-catalog.js";
import type { SystemApplication, SystemTarget } from "./contracts.js";

export type SystemApplicationObservationData = Readonly<{
  target: SystemTarget["id"];
  transport: SystemTarget["transport"];
  absenceConclusionSupported: false;
  completenessMeaning: "declared_catalog_sources_only";
  catalogScope: SystemApplicationCatalogScope;
  catalogComplete: boolean;
  observedMatches: number;
  omittedMatches: number;
  applications: readonly SystemApplication[];
}>;

/** Canonical bounded summary for the structured catalog observation. */
export function formatSystemApplicationSummary(data: SystemApplicationObservationData): string {
  const summaryRoots = data.catalogScope.roots.slice(0, 16).map((root) => root.slice(0, 256));
  const summary = {
    ...data,
    catalogScope: { ...data.catalogScope, roots: summaryRoots },
    summaryRootsOmitted: Math.max(0, data.catalogScope.roots.length - summaryRoots.length),
    summaryRootCharactersOmitted: data.catalogScope.roots.reduce(
      (total, root, index) => total + root.length - (summaryRoots[index]?.length ?? 0), 0,
    ),
    applications: [...data.applications],
    summaryApplicationsOmitted: 0,
  };
  while (hasOverBudgetApplicationSummary(summary)) {
    summary.applications.pop();
    summary.summaryApplicationsOmitted += 1;
  }
  while (hasOverBudgetCatalogRootSummary(summary)) {
    const removedRoot = summary.catalogScope.roots.pop()!;
    summary.summaryRootsOmitted += 1;
    summary.summaryRootCharactersOmitted += removedRoot.length;
  }
  return JSON.stringify(summary);
}

function hasOverBudgetApplicationSummary(summary: { applications: readonly unknown[] }): boolean {
  if (summary.applications.length === 0) return false;
  return JSON.stringify(summary).length > 7_000;
}

function hasOverBudgetCatalogRootSummary(summary: { catalogScope: { roots: readonly string[] } }): boolean {
  if (summary.catalogScope.roots.length === 0) return false;
  return JSON.stringify(summary).length > 7_000;
}
