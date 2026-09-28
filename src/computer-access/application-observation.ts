import type { SystemApplicationCatalog } from "./application-catalog.js";
import type { SystemTarget } from "./contracts.js";

const SUMMARY_MAX_CHARS = 7_000;
const SUMMARY_ROOT_LIMIT = 16;
const SUMMARY_ROOT_CHARS = 256;

export function systemApplicationObservation(
  target: SystemTarget,
  catalog: SystemApplicationCatalog,
  query: string,
  limit: number,
) {
  const matches = catalog.applications.filter((application) =>
    matchesApplicationQuery(application.name, application.id, query),
  );
  const data = {
    target: target.id,
    transport: target.transport,
    absenceConclusionSupported: false,
    completenessMeaning: "declared_catalog_sources_only",
    catalogScope: catalog.scope,
    catalogComplete: catalog.complete,
    observedMatches: matches.length,
    omittedMatches: Math.max(0, matches.length - limit),
    applications: matches.slice(0, limit),
  };
  const summaryRoots = catalog.scope.roots
    .slice(0, SUMMARY_ROOT_LIMIT)
    .map((root) => root.slice(0, SUMMARY_ROOT_CHARS));
  const summary = {
    ...data,
    catalogScope: { ...catalog.scope, roots: summaryRoots },
    summaryRootsOmitted: Math.max(
      0,
      catalog.scope.roots.length - summaryRoots.length,
    ),
    summaryRootCharactersOmitted: catalog.scope.roots.reduce(
      (total, root, index) =>
        total + root.length - (summaryRoots[index]?.length ?? 0),
      0,
    ),
    applications: [...data.applications],
    summaryApplicationsOmitted: 0,
  };
  while (isApplicationSummaryOverBudget(summary)) {
    summary.applications.pop();
    summary.summaryApplicationsOmitted += 1;
  }
  while (isCatalogRootSummaryOverBudget(summary)) {
    const removedRoot = summary.catalogScope.roots.pop()!;
    summary.summaryRootsOmitted += 1;
    summary.summaryRootCharactersOmitted += removedRoot.length;
  }
  return { output: JSON.stringify(summary), data };
}

function matchesApplicationQuery(
  name: string,
  id: string,
  query: string,
): boolean {
  if (name.toLowerCase().includes(query)) return true;
  return id.toLowerCase().includes(query);
}
function isApplicationSummaryOverBudget(summary: {
  applications: readonly unknown[];
}): boolean {
  if (summary.applications.length === 0) return false;
  return JSON.stringify(summary).length > SUMMARY_MAX_CHARS;
}

function isCatalogRootSummaryOverBudget(summary: {
  catalogScope: { roots: readonly string[] };
}): boolean {
  if (summary.catalogScope.roots.length === 0) return false;
  return JSON.stringify(summary).length > SUMMARY_MAX_CHARS;
}
