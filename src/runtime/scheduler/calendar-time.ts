export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}
interface CalendarParts extends CalendarDate {
  hour: number;
  minute: number;
  second: number;
}
function calendarFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}
function readCalendarParts(
  formatter: Intl.DateTimeFormat,
  instant: number,
): CalendarParts {
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}
function calendarPartsAsUtc(parts: CalendarParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}
export function calendarDateAt(
  instant: number,
  timeZone: string,
): CalendarDate {
  const { year, month, day } = readCalendarParts(
    calendarFormatter(timeZone),
    instant,
  );
  return { year, month, day };
}
export function addCalendarDays(
  date: CalendarDate,
  days: number,
): CalendarDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}
export function calendarWeekday(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}
/** Missing wall times are skipped; repeated wall times select the first occurrence. */
export function resolveCalendarTime(
  date: CalendarDate,
  at: string,
  timeZone: string,
): number | null {
  const [hour, minute] = at.split(":").map(Number);
  const wanted = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const formatter = calendarFormatter(timeZone);
  const offsets = new Set<number>();
  // Both sides of a transition are observed, including half-hour and date-line changes.
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = wanted + hours * 3_600_000;
    offsets.add(
      calendarPartsAsUtc(readCalendarParts(formatter, probe)) - probe,
    );
  }
  const candidates = [...offsets]
    .map((offset) => wanted - offset)
    .filter(
      (instant) =>
        calendarPartsAsUtc(readCalendarParts(formatter, instant)) === wanted,
    )
    .sort((a, b) => a - b);
  return candidates[0] ?? null;
}
