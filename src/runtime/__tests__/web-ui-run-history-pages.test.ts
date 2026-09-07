import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createSchedulesController } from "../../web-ui/app/controllers/schedules-controller.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createScheduleRequests } from "../../web-ui/app/services/runtime-web-client/schedules.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { renderScheduleDetails } from "../../web-ui/app/components/schedules/details.js";

type RunPage = { runs: { id: string }[]; nextCursor: string | null };
const pages: Record<string, RunPage> = {
  latest: { runs: [{ id: "run-5" }, { id: "run-4" }], nextCursor: "run-4" },
  "run-4": { runs: [{ id: "run-3" }, { id: "run-2" }], nextCursor: "run-2" },
  "run-2": { runs: [{ id: "run-1" }], nextCursor: null },
};

function fixture() {
  let environmentId = "dev";
  let timer: (() => void) | undefined;
  const jobs = [
    { id: "job-1", state: "active" },
    { id: "job-2", state: "active" },
  ];
  const client = {
    listSchedules: vi.fn(async () => ({
      jobs,
    })),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    listModels: vi.fn(async () => ({ profiles: [] })),
    listScheduleRuns: vi.fn(
      async (
        _jobId: string,
        _environment: string,
        query?: { cursor?: string },
      ): Promise<RunPage> => pages[query?.cursor || "latest"],
    ),
    createSchedule: vi.fn(async () => {
      const job = { id: "job-created", state: "active" };
      jobs.push(job);
      return { job };
    }),
    updateSchedule: vi.fn(async () => ({ job: { id: "job-1" } })),
  };
  const render = vi.fn();
  const controller = createSchedulesController({
    client,
    getEnvironmentId: () => environmentId,
    render,
    openConversation: vi.fn(),
    setTimer: (callback: () => void) => {
      timer = callback;
      return 1;
    },
    clearTimer: () => {},
  });
  return {
    client,
    controller,
    render,
    setEnvironment: (value: string) => {
      environmentId = value;
    },
    poll: () => timer!(),
  };
}

describe("Web run history pages", () => {
  it("keeps one page, visits every older run, and returns through newer pages", async () => {
    const { controller, client } = fixture();
    await controller.load();
    await controller.select("job-1");
    expect(controller.snapshot().runs).toEqual(pages.latest.runs);
    await controller.olderRuns();
    expect(controller.snapshot().runs).toEqual(pages["run-4"].runs);
    expect(client.listScheduleRuns).toHaveBeenLastCalledWith("job-1", "dev", {
      cursor: "run-4",
    });
    await controller.olderRuns();
    expect(controller.snapshot().runs).toEqual(pages["run-2"].runs);
    const calls = client.listScheduleRuns.mock.calls.length;
    await controller.olderRuns();
    expect(client.listScheduleRuns).toHaveBeenCalledTimes(calls);
    await controller.newerRuns();
    expect(controller.snapshot().runs).toEqual(pages["run-4"].runs);
    await controller.latestRuns();
    expect(controller.snapshot().runs).toEqual(pages.latest.runs);
    expect(controller.snapshot().runsPreviousCursors).toEqual([]);
  });

  it("polls the displayed older page and discards its late response after newer navigation", async () => {
    const f = fixture();
    await f.controller.load();
    await f.controller.select("job-1");
    await f.controller.olderRuns();
    f.controller.setActive(true);
    await vi.waitFor(() => expect(f.render).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(f.client.listScheduleRuns).toHaveBeenCalledTimes(3),
    );
    f.controller.cancelEdit();
    let settle!: (value: RunPage) => void;
    f.client.listScheduleRuns.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    f.poll();
    await vi.waitFor(() =>
      expect(f.client.listScheduleRuns).toHaveBeenCalledTimes(4),
    );
    expect(f.client.listScheduleRuns).toHaveBeenLastCalledWith("job-1", "dev", {
      cursor: "run-4",
    });
    await f.controller.newerRuns();
    settle({ runs: [{ id: "stale-older" }], nextCursor: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.controller.snapshot().runs).toEqual(pages.latest.runs);
    expect(f.controller.snapshot().runsCursor).toBeNull();
    f.controller.setActive(false);
  });

  it.each(["select", "openJob", "create", "environment"])(
    "resets history on %s changes",
    async (change) => {
      const f = fixture();
      await f.controller.load();
      await f.controller.select("job-1");
      await f.controller.olderRuns();
      let expectedJob = "job-2";
      let expectedEnvironment = "dev";
      if (change === "select") await f.controller.select("job-2");
      if (change === "openJob") await f.controller.openJob("job-2");
      if (change === "create") {
        f.controller.beginEdit();
        await f.controller.save({});
        expectedJob = "job-created";
      }
      if (change === "environment") {
        f.setEnvironment("prod");
        await f.controller.load();
        await f.controller.select("job-2");
        expectedEnvironment = "prod";
      }
      expect(f.client.listScheduleRuns).toHaveBeenLastCalledWith(
        expectedJob,
        expectedEnvironment,
        { cursor: undefined },
      );
      expect(f.controller.snapshot().runsPreviousCursors).toEqual([]);
      expect(f.controller.snapshot().runs).toEqual(pages.latest.runs);
    },
  );

  it("keeps navigation available when an older cursor becomes unavailable", async () => {
    const f = fixture();
    await f.controller.load();
    await f.controller.select("job-1");
    f.client.listScheduleRuns.mockRejectedValueOnce(
      new Error("scheduler_run_cursor_not_found"),
    );
    await f.controller.olderRuns();
    expect(f.controller.snapshot().detailError).toBeTruthy();
    expect(f.controller.snapshot().runs).toEqual([]);
    expect(f.controller.snapshot().runsPreviousCursors).toEqual([null]);
    await f.controller.latestRuns();
    expect(f.controller.snapshot().detailError).toBe("");
    expect(f.controller.snapshot().runs).toEqual(pages.latest.runs);
  });

  it("scopes and encodes the cursor and optional limit in the Web request", async () => {
    const requestApi = vi.fn(async () => ({}));
    const client = createScheduleRequests({
      requestApi,
      getEnvironmentId: () => "dev / one",
      getConfig: () => ({ backend: "runtime" }),
    });
    await client.listScheduleRuns("job/a", undefined, {
      cursor: "run /?",
      limit: 25,
    });
    expect(requestApi).toHaveBeenLastCalledWith(
      "/schedules/job%2Fa/runs?environment=dev%20%2F%20one&cursor=run+%2F%3F&limit=25",
      undefined,
    );
  });

  it("renders only the current page and binds history navigation without revealing collapsed prompts", () => {
    const handlers = new Map<string, () => void>();
    const buttons = ["latest", "newer", "older"].map((name) => ({
      dataset: { runPage: name },
      addEventListener: (_event: string, handler: () => void) =>
        handlers.set(name, handler),
    }));
    const root = {
      innerHTML: "",
      classList: { add: vi.fn(), remove: vi.fn() },
      querySelectorAll: (selector: string) =>
        selector === "[data-run-page]" ? buttons : [],
      querySelector: () => ({ addEventListener: vi.fn() }),
    };
    const actions = {
      latestRuns: vi.fn(),
      newerRuns: vi.fn(),
      olderRuns: vi.fn(),
    };
    const snapshot = {
      selectedId: "job-1",
      sessions: [],
      mutation: "",
      runsCursor: "run-4",
      runsPreviousCursors: [null],
      runsNextCursor: "run-2",
      jobs: [
        {
          id: "job-1",
          title: "History",
          sessionId: "session",
          state: "active",
          schedule: { kind: "daily", at: "09:00" },
          timeZone: "UTC",
        },
      ],
      runs: pages["run-4"].runs.map((run) => ({
        ...run,
        timeZone: "UTC",
        prompt: "Exact prompt",
        scheduledAt: "2026-09-06T09:00:00Z",
        status: "succeeded",
        resultText: "Full result",
      })),
    };
    renderScheduleDetails({ root, actions, snapshot });
    expect(root.innerHTML.match(/data-run-id=/g)).toHaveLength(2);
    expect(root.innerHTML).not.toContain('data-run-id="run-5"');
    expect(root.innerHTML).toContain("2 runs on this page");
    expect(root.innerHTML).toContain('data-run-page="older"');
    expect(root.innerHTML).not.toMatch(/<details[^>]*\sopen/);
    for (const name of ["latest", "newer", "older"]) handlers.get(name)!();
    expect(actions.latestRuns).toHaveBeenCalledOnce();
    expect(actions.newerRuns).toHaveBeenCalledOnce();
    expect(actions.olderRuns).toHaveBeenCalledOnce();
    renderScheduleDetails({
      root,
      actions,
      snapshot: {
        ...snapshot,
        runsCursor: null,
        runsPreviousCursors: [],
        runsNextCursor: null,
      },
    });
    for (const name of ["latest", "newer", "older"])
      expect(root.innerHTML).toMatch(
        new RegExp(`data-run-page="${name}" disabled`),
      );
  });
});
