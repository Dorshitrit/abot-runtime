import type { SchedulerService } from "../../runtime/scheduler/contracts.js";

export async function readScheduleRunPage(
  service: Pick<SchedulerService, "listRuns">,
  jobId: string | undefined,
  params: URLSearchParams,
) {
  const limit = requireWebRunPageLimit(params.get("limit"));
  const cursor = params.get("cursor") ?? undefined;
  // Bound the owner response before it crosses the shared Runtime transport.
  const page = await service.listRuns(jobId, { cursor, limit: limit + 1 });
  const runs = page.slice(0, limit);
  return {
    runs,
    nextCursor: page.length > limit ? runs.at(-1)!.id : null,
  };
}

function requireWebRunPageLimit(value: string | null): number {
  if (value === null) return 50;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit))
    throw new Error("scheduler_run_page_limit_invalid");
  if (limit < 1) throw new Error("scheduler_run_page_limit_invalid");
  if (limit > 100) throw new Error("scheduler_run_page_limit_invalid");
  return limit;
}
