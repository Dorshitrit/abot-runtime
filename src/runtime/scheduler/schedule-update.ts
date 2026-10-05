import type {
  SchedulerScheduleInput,
  SchedulerTimedSchedule,
} from "./contracts.js";
import { normalizeSchedulerSchedule } from "./schedule-validation.js";

/** PATCH preserves omitted or exact stored timing; actual edits are new input. */
export function normalizeSchedulerScheduleUpdate(
  stored: SchedulerTimedSchedule,
  input: SchedulerScheduleInput | undefined,
  now: number,
): SchedulerTimedSchedule {
  if (input === undefined) return stored;
  if (isExactStoredTimerSchedule(stored, input)) return stored;
  return normalizeSchedulerSchedule(input, now);
}

function isExactStoredTimerSchedule(
  stored: SchedulerTimedSchedule,
  input: SchedulerScheduleInput,
): boolean {
  if (!input || typeof input !== "object") return false;
  if (stored.kind !== "timer") return false;
  if (input.kind !== "timer") return false;
  if (input.delayMs !== stored.delayMs) return false;
  if (!("at" in input)) return false;
  return input.at === stored.at;
}
