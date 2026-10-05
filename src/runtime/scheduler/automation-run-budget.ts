import type { SchedulerAutomationJob } from "./contracts.js";
import type { SchedulerContext } from "./service-context.js";

/** Counts admitted Runs on the Job's local calendar day across all revisions. */
export async function hasReachedAutomationDailyRunLimit(
  context: SchedulerContext,
  job: SchedulerAutomationJob,
  at: number,
): Promise<boolean> {
  const read = context.store.readAutomations;
  if (!read) throw new Error("automation_store_unavailable");
  const state = await read();
  const definition = state.definitions.find((item) =>
    item.automationId === job.target.automationId &&
    item.revision === job.target.definitionRevision)?.definition;
  if (!definition) return false; // Preparation records the missing revision once.
  const count = context.store.countAutomationRunsOnDay;
  if (!count) throw new Error("automation_run_budget_unavailable");
  const admitted = await count(job.target.automationId, job.timeZone, at);
  return admitted >= definition.limits.maxRunsPerDay;
}
