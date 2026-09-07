import { SchedulerValidationError } from "./validation-error.js";

const MIN_SCHEDULER_INSTANT = Date.parse("0000-01-01T00:00:00.000Z");
const MAX_SCHEDULER_INSTANT = Date.parse("9999-12-31T23:59:59.999Z");

export function parseSchedulerInstant(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new SchedulerValidationError(
      "scheduler_invalid_schedule",
      `${field} requires an ISO instant`,
    );
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i.exec(
      value,
    );
  if (!match) {
    throw new SchedulerValidationError(
      "scheduler_invalid_schedule",
      `${field} requires an ISO instant with an explicit UTC offset`,
    );
  }
  const [, year, month, day, hour, minute, second = "0"] = match;
  if (!isExistingCalendarDate(Number(year), Number(month), Number(day))) {
    throw new SchedulerValidationError(
      "scheduler_invalid_schedule",
      `${field} contains an invalid date`,
    );
  }
  if (!isExistingClockTime(Number(hour), Number(minute), Number(second))) {
    throw new SchedulerValidationError(
      "scheduler_invalid_schedule",
      `${field} contains an invalid time`,
    );
  }
  return schedulerInstantFromMilliseconds(Date.parse(value));
}
function isExistingCalendarDate(
  year: number,
  month: number,
  day: number,
): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const monthDays = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= monthDays[month - 1];
}
function isLeapYear(year: number): boolean {
  if (year % 400 === 0) return true;
  if (year % 100 === 0) return false;
  return year % 4 === 0;
}
function isExistingClockTime(
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (hour > 23) return false;
  if (minute > 59) return false;
  return second <= 59;
}
export function schedulerInstantFromMilliseconds(value: number): string {
  if (!isSupportedSchedulerInstant(value)) {
    throw new SchedulerValidationError(
      "scheduler_invalid_schedule",
      "Instant is outside the supported date range",
    );
  }
  return new Date(value).toISOString();
}

/** Canonical output must be accepted again by the four-digit ISO parser. */
export function isSupportedSchedulerInstant(value: number): boolean {
  if (!Number.isSafeInteger(value)) return false;
  if (value < MIN_SCHEDULER_INSTANT) return false;
  return value <= MAX_SCHEDULER_INSTANT;
}
