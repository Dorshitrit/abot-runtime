import type { AutomationService } from "../../runtime/automations/service.js";
import { parseSchedulerRunFilters } from "../../runtime/scheduler/run-list-filter.js";

export async function readAutomationRunPage(
  service: Pick<AutomationService, "listRuns">,
  automationId: string,
  params: URLSearchParams,
) {
  const limit = requireAutomationRunPageLimit(params.get("limit"));
  const cursor = params.get("cursor") ?? undefined;
  const filters = parseSchedulerRunFilters({
    status: params.get("status") ?? undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
  });
  // Select metadata in the owner before loading or serializing run payloads.
  const page = await service.listRuns(automationId, { ...filters, cursor, limit: limit + 1 });
  const runs = page.slice(0, limit);
  return { runs, nextCursor: page.length > limit ? runs.at(-1)!.id : null };
}

function requireAutomationRunPageLimit(value: string | null): number {
  if (value === null) return 50;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit))
    throw new Error("scheduler_run_page_limit_invalid");
  if (limit < 1) throw new Error("scheduler_run_page_limit_invalid");
  if (limit > 100) throw new Error("scheduler_run_page_limit_invalid");
  return limit;
}
