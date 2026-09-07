import type { SchedulerSchedule } from "./contracts.js";
import {
  isSupportedSchedulerInstant,
  schedulerInstantFromMilliseconds,
} from "./instant-validation.js";
import { SchedulerValidationError } from "./validation-error.js";

type IntervalSchedule = Extract<SchedulerSchedule, { kind: "interval" }>;

export function nextIntervalOccurrence(
  schedule: IntervalSchedule,
  after: number,
): string | null {
  const anchor = Date.parse(schedule.anchorAt);
  const steps = Math.max(
    0,
    Math.floor((after - anchor) / schedule.everyMs) + 1,
  );
  const next = anchor + steps * schedule.everyMs;
  if (!isSupportedSchedulerInstant(next)) return null;
  return schedulerInstantFromMilliseconds(next);
}

/** Admission only: legacy stored intervals remain readable until exhaustion. */
export function requireRepresentableIntervalRecurrence(
  schedule: SchedulerSchedule,
  after: number,
): void {
  if (schedule.kind !== "interval") return;
  const first = nextIntervalOccurrence(schedule, after);
  if (first === null) throwUnsupportedRecurrence();
  const second = nextIntervalOccurrence(schedule, Date.parse(first));
  if (second === null) throwUnsupportedRecurrence();
}

function throwUnsupportedRecurrence(): never {
  throw new SchedulerValidationError(
    "scheduler_invalid_schedule",
    "Interval recurrence is outside the supported date range",
  );
}
