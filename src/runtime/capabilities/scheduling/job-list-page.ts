import type { SchedulerJob } from "../../scheduler/contracts.js";

/** A bounded, passive projection; cursors bind to exact Jobs in this session. */
export function createSchedulerJobPage(
  jobs: readonly SchedulerJob[],
  params: { cursor?: unknown; limit?: unknown },
) {
  const limit = params.limit === undefined ? 100 : params.limit;
  if (!isSupportedPageLimit(limit))
    throw new Error("schedule_page_limit_invalid");
  const ordered = [...jobs].sort(compareNewestJobs);
  const offset = cursorOffset(ordered, params.cursor);
  const page = ordered.slice(offset, offset + limit);
  const omittedCount = Math.max(0, ordered.length - offset - page.length);
  return {
    jobs: page.map(({ prompt: _prompt, ...job }) => job),
    omittedCount,
    nextCursor: omittedCount > 0 ? page.at(-1)!.id : null,
  };
}

function isSupportedPageLimit(value: unknown): value is number {
  if (!Number.isSafeInteger(value)) return false;
  if (Number(value) < 1) return false;
  return Number(value) <= 100;
}

function cursorOffset(jobs: readonly SchedulerJob[], cursor: unknown): number {
  if (cursor === undefined) return 0;
  if (typeof cursor !== "string") throw new Error("schedule_cursor_invalid");
  if (!cursor) throw new Error("schedule_cursor_invalid");
  const index = jobs.findIndex((job) => job.id === cursor);
  if (index < 0) throw new Error("schedule_cursor_not_found");
  return index + 1;
}

function compareNewestJobs(left: SchedulerJob, right: SchedulerJob): number {
  const created = right.createdAt.localeCompare(left.createdAt);
  if (created !== 0) return created;
  return right.id.localeCompare(left.id);
}
