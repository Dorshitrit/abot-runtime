import type {
  RequestToolResult,
  RequestToolResultsView,
} from "../../context/request-tool-results.js";

export type PlannerToolResultsProjection = Readonly<{
  view: RequestToolResultsView;
  sourceResultCount: number;
  supersededResultCount: number;
  retainedFailedResultCount: number;
  retainedUntargetedResultCount: number;
}>;

/**
 * Projects request-wide execution history into the current settled state that
 * the Planner needs for completion decisions. A later result supersedes an
 * earlier result only when every declared target of the earlier result has a
 * later execution. Untargeted results remain because they have no safe
 * supersession identity.
 */
export function projectPlannerToolResults(
  source: RequestToolResultsView,
): PlannerToolResultsProjection {
  const latestIndexByTarget = new Map<string, number>();
  for (let index = 0; index < source.results.length; index += 1) {
    for (const reference of source.results[index]!.references ?? []) {
      latestIndexByTarget.set(reference.target, index);
    }
  }

  const results: RequestToolResult[] = [];
  let supersededResultCount = 0;
  let retainedFailedResultCount = 0;
  let retainedUntargetedResultCount = 0;

  for (let index = 0; index < source.results.length; index += 1) {
    const result = source.results[index]!;
    const targets = (result.references ?? []).map(({ target }) => target);
    if (
      targets.length > 0 &&
      targets.every((target) => latestIndexByTarget.get(target) !== index)
    ) {
      supersededResultCount += 1;
      continue;
    }
    if (result.outcome === "failed") retainedFailedResultCount += 1;
    if (targets.length === 0) retainedUntargetedResultCount += 1;
    results.push(result);
  }

  return Object.freeze({
    view: Object.freeze({
      sourceRevision: source.sourceRevision,
      results: Object.freeze(results),
    }),
    sourceResultCount: source.results.length,
    supersededResultCount,
    retainedFailedResultCount,
    retainedUntargetedResultCount,
  });
}
