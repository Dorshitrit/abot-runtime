import { nextSchedulerOccurrence } from "../../scheduler/next-occurrence.js";
import {
  addCalendarDays,
  calendarDateAt,
  resolveCalendarTime,
} from "../../scheduler/calendar-time.js";
import type { CoWorkerResourceUsage } from "./contracts.js";

function nextLocalMidnight(now: number, timeZone: string): number {
  const next = nextSchedulerOccurrence(
    { kind: "daily", at: "00:00" },
    timeZone,
    now,
  );
  if (!next) throw new Error("co_worker_budget_reset_unavailable");
  return Date.parse(next);
}

function previousLocalMidnight(now: number, timeZone: string): number {
  const current = calendarDateAt(now, timeZone);
  for (let offset = 0; offset < 370; offset += 1) {
    const midnight = resolveCalendarTime(
      addCalendarDays(current, -offset),
      "00:00",
      timeZone,
    );
    if (midnight !== null && midnight <= now) return midnight;
  }
  throw new Error("co_worker_budget_reset_unavailable");
}

/** A zone edit never advances an existing reset or creates a short transition day. */
export function resolveCoWorkerBudgetDay(
  previous: CoWorkerResourceUsage | undefined,
  now: number,
  timeZone: string,
): CoWorkerResourceUsage {
  if (!Number.isFinite(now)) throw new Error("co_worker_budget_clock_invalid");
  if (previous && now < previous.resetsAt) return previous;
  let resetsAt = nextLocalMidnight(now, timeZone);
  if (previous && previous.timeZone !== timeZone) {
    const oldZoneNextReset = nextLocalMidnight(now, previous.timeZone);
    if (resetsAt < oldZoneNextReset)
      resetsAt = nextLocalMidnight(oldZoneNextReset - 1, timeZone);
  }
  return Object.freeze({
    schemaVersion: 1,
    timeZone,
    startedAt: Math.max(
      previous?.resetsAt ?? -Infinity,
      previousLocalMidnight(now, timeZone),
    ),
    resetsAt,
    modelCalls: 0,
    embeddingCalls: 0,
    embeddingCharacters: 0,
  });
}
