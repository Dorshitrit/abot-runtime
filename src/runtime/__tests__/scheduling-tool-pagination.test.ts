import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../../capabilities/tool-types.js";
import { createSchedulingToolModule } from "../capabilities/scheduling/tool-module.js";
import type { RuntimeConfig } from "../ports.js";
import type { SchedulerJob, SchedulerService } from "../scheduler/contracts.js";

function fixture(count = 205) {
  const jobs: SchedulerJob[] = Array.from({ length: count }, (_, index) => ({
    id: `job-${String(index).padStart(3, "0")}`,
    environmentId: "dev",
    sessionId: "conversation",
    title: `Task ${index}`,
    prompt: "Stored future prompt must remain private to explicit get.",
    modelProfileId: "model",
    agentMode: "reasoning",
    toolPermissionMode: "full_access",
    timeZone: "UTC",
    schedule: { kind: "daily", at: "09:00" },
    state: index < 100 ? "completed" : "active",
    revision: 1,
    createdAt: new Date(Date.UTC(2026, 8, 6) + index).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, 6) + index).toISOString(),
    nextRunAt: null,
  }));
  const list = vi.fn<SchedulerService["list"]>().mockResolvedValue(jobs);
  const get = vi.fn<SchedulerService["get"]>(
    async (id) => jobs.find((job) => job.id === id) ?? null,
  );
  const listRuns = vi.fn<SchedulerService["listRuns"]>().mockResolvedValue([]);
  const runNow = vi.fn<SchedulerService["runNow"]>();
  const service = {
    list,
    get,
    listRuns,
    runNow,
  } as unknown as SchedulerService;
  // List/get use only the injected store and current-session binding.
  const module = createSchedulingToolModule(
    service,
    {} as RuntimeConfig,
    async () => {},
  );
  const context: ToolExecutionContext = {
    sharedState: { currentSessionId: "conversation" },
  };
  const invoke = (params: Record<string, unknown>) =>
    module.implementation(params, context);
  return { jobs, list, runNow, module, invoke };
}

describe("scheduling tool pagination", () => {
  it("discovers every Job beyond the oldest 100 through bounded newest-first pages", async () => {
    const f = fixture();
    const first = JSON.parse((await f.invoke({ action: "list" })).output);
    expect(first.jobs).toHaveLength(100);
    expect(first.jobs[0].id).toBe("job-204");
    expect(first.omittedCount).toBe(105);
    expect(first.nextCursor).toBe("job-105");
    const second = JSON.parse(
      (await f.invoke({ action: "list", cursor: first.nextCursor })).output,
    );
    const third = JSON.parse(
      (await f.invoke({ action: "list", cursor: second.nextCursor })).output,
    );
    expect(second.jobs).toHaveLength(100);
    expect(third.jobs).toHaveLength(5);
    expect(third.nextCursor).toBeNull();
    expect(third.omittedCount).toBe(0);
    const all = [...first.jobs, ...second.jobs, ...third.jobs];
    expect(new Set(all.map((job) => job.id)).size).toBe(205);
    expect(all.every((job) => !("prompt" in job))).toBe(true);
    expect(f.list).toHaveBeenCalledWith({ sessionId: "conversation" });
    expect(f.runNow).not.toHaveBeenCalled();
    expect(f.jobs[0].id).toBe("job-000");
  });

  it("keeps exact cursor binding after new Jobs are added and metadata is edited", async () => {
    const f = fixture(5);
    const first = JSON.parse(
      (await f.invoke({ action: "list", limit: 2 })).output,
    );
    expect(first.jobs.map((job: { id: string }) => job.id)).toEqual([
      "job-004", "job-003",
    ]);
    f.jobs.push({
      ...f.jobs[4],
      id: "new-job",
      createdAt: "2026-09-07T00:00:00.000Z",
    });
    f.jobs[3].title = "Renamed cursor Job";
    const second = JSON.parse(
      (await f.invoke({ action: "list", limit: 2, cursor: first.nextCursor }))
        .output,
    );
    expect(second.jobs.map((job: { id: string }) => job.id)).toEqual([
      "job-002", "job-001",
    ]);
    const direct = JSON.parse(
      (await f.invoke({ action: "get", jobId: "job-002" })).output,
    );
    expect(direct.job.id).toBe("job-002");
    expect(direct.job.prompt).toBe(f.jobs[2].prompt);
  });

  it("rejects unknown or stale cursors without falling back to another conversation", async () => {
    const f = fixture(5);
    const first = JSON.parse(
      (await f.invoke({ action: "list", limit: 2 })).output,
    );
    f.jobs.splice(3, 1);
    for (const cursor of [first.nextCursor, "foreign-session-job", ""]) {
      expect(await f.invoke({ action: "list", cursor })).toMatchObject({
        ok: false,
      });
    }
    expect(
      f.list.mock.calls.every(
        ([filter]) => filter?.sessionId === "conversation",
      ),
    ).toBe(true);
    expect(f.runNow).not.toHaveBeenCalled();
  });

  it.each([0, -1, 101, 1.5, "20", Number.NaN, null])(
    "rejects invalid page limit %j",
    async (limit) => {
      const f = fixture(1);
      expect(await f.invoke({ action: "list", limit })).toMatchObject({
        ok: false,
        error: "schedule_page_limit_invalid",
      });
    },
  );

  it("declares bounded pagination only on the read-only list operation", () => {
    const f = fixture(0);
    const operations = f.module.normalInvocation!.operations;
    const list = operations.find((item) => item.operationId === "list")!;
    expect(list.effect).toBe("read_only");
    expect(list.input.properties.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 100,
    });
    expect(list.input.properties.cursor).toMatchObject({ type: "string" });
    for (const operation of operations.filter(
      (item) => item.operationId !== "list",
    )) {
      expect(operation.input.properties).not.toHaveProperty("cursor");
      expect(operation.input.properties).not.toHaveProperty("limit");
    }
  });
});
