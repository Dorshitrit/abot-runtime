import { describe, expect, it } from "vitest";
import type { SchedulerRunListQuery, SchedulerStoredRun } from "../scheduler/contracts.js";
import { querySchedulerRuns } from "../scheduler/run-list-query.js";

type Run = Pick<SchedulerStoredRun, "id" | "jobId" | "scheduledAt" | "status">;
const instant = (index: number) => new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString();
function records(count: number): Run[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `run-${String(index).padStart(4, "0")}`, jobId: "job",
    scheduledAt: instant(index), status: index % 4 === 0 ? "failed" : "succeeded",
  }));
}

describe("scheduler run history filters", () => {
  it("finds every matching run across more than 1,000 records before applying page limits", () => {
    const runs = records(1_005);
    const query: SchedulerRunListQuery = { limit: 50, status: "failed", from: instant(100), to: instant(1_000) };
    const found: string[] = [];
    for (;;) {
      const page = querySchedulerRuns(runs, "job", query);
      found.push(...page.map((run) => run.id));
      if (page.length < query.limit) break;
      query.cursor = page.at(-1)!.id;
    }
    const expected = runs.filter((run) => run.status === "failed" &&
      run.scheduledAt >= instant(100) && run.scheduledAt < instant(1_000)).reverse();
    expect(found).toEqual(expected.map((run) => run.id));
    expect(found).toHaveLength(225);
    expect(new Set(found).size).toBe(found.length);
    expect(querySchedulerRuns(runs, "job", undefined)).toEqual(runs);
  });

  it("uses an exact scoped cursor even when its status no longer matches", () => {
    const runs = records(12);
    const first = querySchedulerRuns(runs, "job", { status: "failed", limit: 1 });
    first[0].status = "succeeded";
    const next = querySchedulerRuns(runs, "job", { status: "failed", limit: 2, cursor: first[0].id });
    expect(next.map((run) => run.id)).toEqual(["run-0004", "run-0000"]);
    runs.push({ ...runs[0], id: "foreign", jobId: "other" });
    for (const cursor of ["foreign", "missing"])
      expect(() => querySchedulerRuns(runs, "job", { status: "failed", limit: 2, cursor }))
        .toThrow("scheduler_run_cursor_not_found");
  });

  it("breaks timestamp ties by ID and retains inclusive-from/exclusive-to semantics across offsets", () => {
    const runs = records(4).map((run, index) => ({ ...run, status: "failed" as const,
      scheduledAt: index < 3 ? instant(0) : instant(1) }));
    const query = { status: "failed" as const, from: "2026-10-01T03:00:00+03:00", to: instant(1), limit: 2 };
    const first = querySchedulerRuns(runs, "job", query);
    const next = querySchedulerRuns(runs, "job", { ...query, cursor: first.at(-1)!.id });
    expect([...first, ...next].map((run) => run.id)).toEqual(["run-0002", "run-0001", "run-0000"]);
  });

  it.each([
    { status: "unknown" }, { status: "" }, { from: "2026-10-01" },
    { from: "2026-02-30T00:00:00Z" }, { to: "2026-10-01T24:00:00Z" },
    { from: instant(1), to: instant(0) }, { from: instant(0), to: instant(0) },
    { from: 42 }, { to: "" },
  ])("rejects invalid filters even with empty history: %j", (filter) => {
    expect(() => querySchedulerRuns([], "job", { limit: 50, ...filter } as SchedulerRunListQuery))
      .toThrow(/scheduler_run_(status|date)/);
  });
});
