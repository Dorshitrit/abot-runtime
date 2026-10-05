import type { SchedulerAutomationJob, SchedulerAutomationScheduleInput } from "../scheduler/contracts.js";
import type { AutomationScheduleTiming } from "../scheduler/automation-schedule.js";
import type { AutomationTrigger } from "./definition-contracts.js";
import type { AutomationJournalState } from "./storage-records.js";

export function automationTriggerSchedule(trigger: AutomationTrigger): SchedulerAutomationScheduleInput {
  switch (trigger.kind) {
    case "manual": return { kind: "manual" };
    case "schedule": return trigger.schedule;
    case "folder": return { kind: "interval", everyMs: trigger.checkEveryMs };
  }
}

/** Only the exact retained publication can identify unchanged authored relative timing. */
export function publishedAutomationScheduleTiming(
  state: AutomationJournalState, job: SchedulerAutomationJob | null | undefined,
  trigger: AutomationTrigger | undefined,
): AutomationScheduleTiming | undefined {
  if (!job) return undefined;
  const timing = { schedule: job.schedule, timeZone: job.timeZone };
  const published = state.definitions.find((record) =>
    record.automationId === job.target.automationId && record.revision === job.target.definitionRevision);
  if (!published || !trigger) return timing;
  if (published.definition.trigger.kind !== trigger.kind) return timing;
  return { ...timing, authoredSchedule: automationTriggerSchedule(published.definition.trigger) };
}
