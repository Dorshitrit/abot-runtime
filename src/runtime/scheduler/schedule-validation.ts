import type {
  CreateSchedulerJobInput,
  SchedulerSchedule,
  SchedulerScheduleInput,
} from "./contracts.js";

import { SchedulerValidationError } from "./validation-error.js";
import {
  parseSchedulerInstant,
  schedulerInstantFromMilliseconds,
} from "./instant-validation.js";
export { SchedulerValidationError } from "./validation-error.js";
export { parseSchedulerInstant } from "./instant-validation.js";

export function requireSchedulerText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new SchedulerValidationError(
      "scheduler_invalid_job",
      `${field} must be text`,
    );
  }
  const text = value.trim();
  if (!text)
    throw new SchedulerValidationError(
      "scheduler_invalid_job",
      `${field} is required`,
    );
  return text;
}
export function validateSchedulerJobInput(
  input: CreateSchedulerJobInput,
): void {
  if (!input || typeof input !== "object") {
    throw new SchedulerValidationError(
      "scheduler_invalid_job",
      "job input is required",
    );
  }
  for (const field of [
    "sessionId",
    "title",
    "prompt",
    "modelProfileId",
  ] as const) {
    requireSchedulerText(input[field], field);
  }
  const allowedModes = ["fast", "reasoning", "deep"];
  if (!allowedModes.includes(input.agentMode)) {
    throw new SchedulerValidationError(
      "scheduler_invalid_job",
      "agentMode is invalid",
    );
  }
  validateTimeZone(input.timeZone);
}
export function validateTimeZone(timeZone: string): void {
  try {
    requireSchedulerText(timeZone, "timeZone");
    new Intl.DateTimeFormat("en", { timeZone }).format();
  } catch {
    throw new SchedulerValidationError(
      "scheduler_invalid_timezone",
      "An IANA timeZone is required",
    );
  }
}
function requirePositiveDuration(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new SchedulerValidationError(
      "scheduler_invalid_schedule",
      "duration must be integer milliseconds",
    );
  }
  if (value < 1_000) {
    throw new SchedulerValidationError(
      "scheduler_invalid_schedule",
      "duration must be at least one second",
    );
  }
  return value;
}
export function requireCalendarHour(value: unknown): string {
  if (typeof value !== "string") {
    throw new SchedulerValidationError(
      "scheduler_exact_time_required",
      "Supply an exact HH:mm time",
    );
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new SchedulerValidationError(
      "scheduler_exact_time_required",
      "Supply an exact HH:mm time",
    );
  }
  return value;
}
export function normalizeSchedulerSchedule(
  input: SchedulerScheduleInput,
  now: number,
): SchedulerSchedule {
  if (!input || typeof input !== "object") {
    throw new SchedulerValidationError(
      "scheduler_invalid_schedule",
      "schedule is required",
    );
  }
  switch (input.kind) {
    case "timer": {
      const delayMs = requirePositiveDuration(input.delayMs);
      const at = schedulerInstantFromMilliseconds(now + delayMs);
      return { kind: "timer", delayMs, at };
    }
    case "once":
      return { kind: "once", at: parseSchedulerInstant(input.at, "at") };
    case "interval": {
      const everyMs = requirePositiveDuration(input.everyMs);
      const anchorAt =
        input.anchorAt === undefined
          ? schedulerInstantFromMilliseconds(now + everyMs)
          : parseSchedulerInstant(input.anchorAt, "anchorAt");
      return { kind: "interval", everyMs, anchorAt };
    }
    case "daily":
      return { kind: "daily", at: requireCalendarHour(input.at) };
    case "weekly": {
      const weekdays = normalizeWeekdays(input.weekdays);
      return { kind: "weekly", at: requireCalendarHour(input.at), weekdays };
    }
    case "monthly":
      if (!isSupportedMonthDay(input.dayOfMonth)) {
        throw new SchedulerValidationError(
          "scheduler_invalid_schedule",
          "dayOfMonth must be 1–31",
        );
      }
      return {
        kind: "monthly",
        at: requireCalendarHour(input.at),
        dayOfMonth: input.dayOfMonth,
      };
    default:
      throw new SchedulerValidationError(
        "scheduler_invalid_schedule",
        "Unknown schedule kind",
      );
  }
}

/** Stored timer deadlines are canonical state, not new relative timer input. */
export function normalizeStoredSchedulerSchedule(
  schedule: SchedulerSchedule,
): SchedulerSchedule {
  if (schedule?.kind !== "timer")
    return normalizeSchedulerSchedule(schedule, 0);
  return {
    kind: "timer",
    delayMs: requirePositiveDuration(schedule.delayMs),
    at: parseSchedulerInstant(schedule.at, "at"),
  };
}

function normalizeWeekdays(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new SchedulerValidationError(
      "scheduler_invalid_schedule",
      "weekdays must contain Sunday=0 through Saturday=6",
    );
  }
  if (value.length === 0) {
    throw new SchedulerValidationError(
      "scheduler_invalid_schedule",
      "Choose at least one weekday",
    );
  }
  if (!value.every(isSupportedWeekday)) {
    throw new SchedulerValidationError(
      "scheduler_invalid_schedule",
      "weekdays must contain integers 0–6",
    );
  }
  return [...new Set(value)].sort((a, b) => a - b);
}
function isSupportedWeekday(value: unknown): value is number {
  if (!Number.isInteger(value)) return false;
  if (Number(value) < 0) return false;
  return Number(value) <= 6;
}
function isSupportedMonthDay(value: number): boolean {
  if (!Number.isInteger(value)) return false;
  if (value < 1) return false;
  return value <= 31;
}
