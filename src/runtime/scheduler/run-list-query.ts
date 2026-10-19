import type { SchedulerStoredRun, SchedulerRunListQuery } from "./contracts.js";
import { createSchedulerRunFilter } from "./run-list-filter.js";

/** Omitted queries retain the public service's complete, chronological result. */
type RunListIdentity = Pick<SchedulerStoredRun, "id" | "jobId" | "scheduledAt" | "status">;
export function querySchedulerRuns<T extends RunListIdentity>(
  runs: readonly T[],
  jobId: string | undefined,
  query: SchedulerRunListQuery | undefined,
): T[] {
  const scoped = runs.filter(
    (run) => jobId === undefined || run.jobId === jobId,
  );
  if (query === undefined) return scoped;
  const limit = requireRunPageLimit(query?.limit);
  const matchesFilter = createSchedulerRunFilter(query);
  const ordered = scoped.sort(compareNewestRuns);
  const offset = runCursorOffset(ordered, query.cursor);
  // Resolve the cursor before filtering: its status may change between pages.
  return ordered.slice(offset).filter(matchesFilter).slice(0, limit);
}

function requireRunPageLimit(limit: unknown): number {
  if (!Number.isSafeInteger(limit))
    throw new Error("scheduler_run_page_limit_invalid");
  if (Number(limit) < 1) throw new Error("scheduler_run_page_limit_invalid");
  if (Number(limit) > 101) throw new Error("scheduler_run_page_limit_invalid");
  return Number(limit);
}

function runCursorOffset(
  runs: readonly RunListIdentity[],
  cursor: unknown,
): number {
  if (cursor === undefined) return 0;
  if (typeof cursor !== "string")
    throw new Error("scheduler_run_cursor_invalid");
  if (!cursor) throw new Error("scheduler_run_cursor_invalid");
  const index = runs.findIndex((run) => run.id === cursor);
  if (index < 0) throw new Error("scheduler_run_cursor_not_found");
  return index + 1;
}

function compareNewestRuns(
  left: RunListIdentity,
  right: RunListIdentity,
): number {
  const scheduled =
    Date.parse(right.scheduledAt) - Date.parse(left.scheduledAt);
  if (scheduled !== 0) return scheduled;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}
