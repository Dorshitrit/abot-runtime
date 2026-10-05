import type {
  SchedulerAutomationScheduleInput,
  SchedulerSchedule,
} from "./contracts.js";
import { normalizeSchedulerSchedule } from "./schedule-validation.js";
import { requireRepresentableIntervalRecurrence } from "./interval-range.js";
import { nextSchedulerOccurrence } from "./next-occurrence.js";
import { SchedulerValidationError } from "./validation-error.js";

export function normalizeAutomationSchedule(
  input: SchedulerAutomationScheduleInput,
  now: number,
  previous?: AutomationScheduleTiming,
): SchedulerSchedule {
  if (input?.kind === "manual") return { kind: "manual" };
  if (hasUnchangedRelativeAutomationSchedule(input, previous)) return previous!.schedule;
  return normalizeSchedulerSchedule(input, now);
}

export type AutomationScheduleTiming = Readonly<{
  schedule: SchedulerSchedule;
  timeZone: string;
  authoredSchedule?: SchedulerAutomationScheduleInput;
}>;

function hasUnchangedRelativeAutomationSchedule(input: SchedulerAutomationScheduleInput,
  previous?: AutomationScheduleTiming): boolean {
  if (!input || !previous?.authoredSchedule) return false;
  const authored = previous.authoredSchedule;
  const stored = previous.schedule;
  if (input.kind === "timer") return hasMatchingTimerDelay(input, authored, stored);
  if (input.kind !== "interval") return false;
  if (authored.kind !== "interval" || stored.kind !== "interval") return false;
  if (input.anchorAt !== undefined || authored.anchorAt !== undefined) return false;
  return input.everyMs === authored.everyMs && input.everyMs === stored.everyMs;
}

function hasMatchingTimerDelay(input: Extract<SchedulerAutomationScheduleInput, { kind: "timer" }>,
  authored: SchedulerAutomationScheduleInput, stored: SchedulerSchedule): boolean {
  if (authored.kind !== "timer" || stored.kind !== "timer") return false;
  return input.delayMs === authored.delayMs && input.delayMs === stored.delayMs;
}

export function hasAutomationScheduleTimingChanged(schedule: SchedulerSchedule, timeZone: string,
  previous?: AutomationScheduleTiming): boolean {
  if (!previous) return true;
  if (JSON.stringify(schedule) !== JSON.stringify(previous.schedule)) return true;
  if (timeZone === previous.timeZone) return false;
  return schedule.kind === "daily" || schedule.kind === "weekly" || schedule.kind === "monthly";
}

/** Shared by schedule admission and draft readiness; stored runs do not reschedule. */
export function requireAutomationScheduleOccurrence(
  schedule: SchedulerSchedule,
  timeZone: string,
  now: number,
): string | null {
  requireRepresentableIntervalRecurrence(schedule, now);
  const nextRunAt = nextSchedulerOccurrence(schedule, timeZone, now);
  if (schedule.kind === "manual" || nextRunAt) return nextRunAt;
  throw new SchedulerValidationError("scheduler_schedule_in_past",
    "Choose a schedule with a future occurrence within the supported date range.");
}
