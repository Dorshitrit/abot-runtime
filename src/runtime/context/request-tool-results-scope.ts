import type { RequestToolResultsView } from "./request-tool-results.js";

/** Requires Planner-item views to carry only their exact call lane. */
export function isRequestToolResultsViewValidForCallScope(
  view: RequestToolResultsView,
  callId: string,
  callScoped: boolean,
): boolean {
  if (!callScoped) return view.scope === undefined;
  return (
    view.scope?.kind === "call" &&
    view.scope.callId === callId &&
    view.results.every((result) => result.callId === callId)
  );
}
