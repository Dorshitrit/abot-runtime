import type { AutomationJournalState } from "./storage-records.js";

/** Hard environment-wide bound while retained reports and replay inputs exist. */
export const MAX_AUTOMATION_RESULT_BYTES = 256 * 1024 * 1024;

export function remainingAutomationResultBytes(state: AutomationJournalState): number {
  return MAX_AUTOMATION_RESULT_BYTES - state.results.reduce((bytes, item) =>
    bytes + item.sizeBytes, 0);
}

export function requireAutomationResultCapacity(
  state: AutomationJournalState,
  newBytes: number,
): void {
  if (newBytes > remainingAutomationResultBytes(state))
    throw new Error("automation_artifact_budget_exhausted");
}
