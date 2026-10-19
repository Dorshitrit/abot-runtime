import type { SchedulerRunListQuery, SchedulerStoredRun } from "./contracts.js";
import { parseSchedulerInstant } from "./instant-validation.js";

type RunFilters = Pick<SchedulerRunListQuery, "status" | "from" | "to">;
type RunFilterInput = { status?: unknown; from?: unknown; to?: unknown };
type FilterableRun = Pick<SchedulerStoredRun, "scheduledAt" | "status">;

export function parseSchedulerRunFilters(input: RunFilterInput): RunFilters {
  const status = requireRunStatusFilter(input.status);
  const from = requireRunDateFilter(input.from, "from");
  const to = requireRunDateFilter(input.to, "to");
  if (hasReversedRunDateRange(from, to))
    throw new Error("scheduler_run_date_range_invalid");
  return { status, from, to };
}

export function createSchedulerRunFilter(input: RunFilters) {
  const filter = parseSchedulerRunFilters(input);
  const from = filter.from === undefined ? undefined : Date.parse(filter.from);
  const to = filter.to === undefined ? undefined : Date.parse(filter.to);
  return (run: FilterableRun): boolean => {
    if (filter.status !== undefined && run.status !== filter.status) return false;
    const scheduledAt = Date.parse(run.scheduledAt);
    if (from !== undefined && scheduledAt < from) return false;
    if (to !== undefined && scheduledAt >= to) return false;
    return true;
  };
}

function requireRunStatusFilter(value: unknown): RunFilters["status"] {
  if (value === undefined) return undefined;
  if (!isSupportedRunStatusFilter(value))
    throw new Error("scheduler_run_status_invalid");
  return value;
}

function isSupportedRunStatusFilter(value: unknown): value is SchedulerStoredRun["status"] {
  if (typeof value !== "string") return false;
  return [
    "pending", "running", "stopping", "succeeded", "completed_with_skips",
    "failed", "cancelled", "interrupted", "missed",
  ].includes(value);
}

function requireRunDateFilter(value: unknown, field: "from" | "to"): string | undefined {
  if (value === undefined) return undefined;
  try {
    return parseSchedulerInstant(value, field);
  } catch {
    throw new Error("scheduler_run_date_filter_invalid");
  }
}

function hasReversedRunDateRange(from: string | undefined, to: string | undefined): boolean {
  if (from === undefined) return false;
  if (to === undefined) return false;
  return Date.parse(from) >= Date.parse(to);
}
