import {
  isSupportedSchedulerInstant,
  schedulerInstantFromMilliseconds,
} from "./instant-validation.js";
import { nextIntervalOccurrence } from "./interval-range.js";
import type { SchedulerSchedule } from "./contracts.js";
import {
  addCalendarDays,
  calendarDateAt,
  calendarWeekday,
  resolveCalendarTime,
} from "./calendar-time.js";

/** Strictly after the supplied instant. Never shifts missing calendar dates or times. */
export function nextSchedulerOccurrence(
  schedule: SchedulerSchedule,
  timeZone: string,
  after: number,
): string | null {
  switch (schedule.kind) {
    case "timer":
    case "once":
      return Date.parse(schedule.at) > after ? schedule.at : null;
    case "interval":
      return nextIntervalOccurrence(schedule, after);
    default:
      return nextCalendarOccurrence(schedule, timeZone, after);
  }
}
function nextCalendarOccurrence(
  schedule: Extract<
    SchedulerSchedule,
    { kind: "daily" | "weekly" | "monthly" }
  >,
  timeZone: string,
  after: number,
): string | null {
  const start = calendarDateAt(after, timeZone);
  for (let offset = 0; offset < 370; offset += 1) {
    const date = addCalendarDays(start, offset);
    if (!matchesCalendarDay(schedule, date)) continue;
    const instant = resolveCalendarTime(date, schedule.at, timeZone);
    if (instant === null) continue;
    if (instant <= after) continue;
    if (!isSupportedSchedulerInstant(instant)) return null;
    return schedulerInstantFromMilliseconds(instant);
  }
  throw new Error("scheduler_next_occurrence_unavailable");
}
function matchesCalendarDay(
  schedule: Extract<
    SchedulerSchedule,
    { kind: "daily" | "weekly" | "monthly" }
  >,
  date: { year: number; month: number; day: number },
): boolean {
  if (schedule.kind === "daily") return true;
  if (schedule.kind === "monthly") return date.day === schedule.dayOfMonth;
  return schedule.weekdays.includes(calendarWeekday(date));
}
