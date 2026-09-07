import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createSchedulesController } from "../../web-ui/app/controllers/schedules-controller.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { matchesScheduleFilter } from "../../web-ui/app/lib/schedule-presentation.js";

function job(id: string, state: string) {
  return {
    id,
    state,
    title: id,
    sessionId: "session-1",
    schedule: { kind: "daily", at: "09:00" },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(
  jobs = [
    job("finished", "completed"),
    job("active", "active"),
    job("paused", "paused"),
  ],
) {
  let environmentId = "dev";
  let poll: () => void = () => {};
  const client = {
    listSchedules: vi.fn(async (_environmentId: string) => ({ jobs })),
    listSessions: vi.fn(async () => ({
      sessions: [{ id: "session-1", title: "Daily notes" }],
    })),
    listModels: vi.fn(async () => ({ profiles: [] })),
    listScheduleRuns: vi.fn(
      async (
        _jobId: string,
        _environmentId: string,
        _query?: { cursor?: string },
      ): Promise<{ runs: { id: string }[]; nextCursor?: string | null }> => ({
        runs: [{ id: "run-1" }],
      }),
    ),
    updateSchedule: vi.fn(async () => ({ job: jobs[1] || jobs[0] })),
    createSchedule: vi.fn(async () => ({ job: jobs[0] })),
    scheduleAction: vi.fn(async () => ({})),
  };
  const render = vi.fn();
  const controller = createSchedulesController({
    client,
    getEnvironmentId: () => environmentId,
    render,
    openConversation: vi.fn(),
    setTimer: vi.fn((callback: () => void) => {
      poll = callback;
    }),
    clearTimer: vi.fn(),
  });
  return {
    client,
    controller,
    render,
    poll: () => poll(),
    changeEnvironment: (value: string) => {
      environmentId = value;
    },
  };
}

async function activate(controller: ReturnType<typeof harness>["controller"]) {
  controller.setActive(true);
  await vi.waitFor(() => expect(controller.snapshot().loading).toBe(false));
}

describe("schedule filters", () => {
  test("Current excludes completed and cancelled while exact filters and All remain available", () => {
    const jobs = [
      job("active", "active"),
      job("paused", "paused"),
      job("done", "completed"),
      job("cancelled", "cancelled"),
    ];
    const visible = (filter: string) =>
      jobs
        .filter((item) => matchesScheduleFilter(item, "", filter))
        .map((item) => item.id);
    expect(visible("current")).toEqual(["active", "paused"]);
    expect(visible("completed")).toEqual(["done"]);
    expect(visible("cancelled")).toEqual(["cancelled"]);
    expect(visible("all")).toEqual(jobs.map((item) => item.id));
    expect(visible("")).toEqual(visible("all"));
  });

  test("combines the chosen status with conversation-aware search", () => {
    const item = job("task", "paused");
    const sessions = [{ id: "session-1", title: "Daily notes" }];
    expect(matchesScheduleFilter(item, "notes", "current", sessions)).toBe(
      true,
    );
    expect(matchesScheduleFilter(item, "notes", "completed", sessions)).toBe(
      false,
    );
    expect(matchesScheduleFilter(item, "absent", "current", sessions)).toBe(
      false,
    );
  });
});

describe("schedule entry and selection", () => {
  test("broadening a filter retains the nonfirst visible selection and its history page", async () => {
    const { controller, client } = harness();
    client.listScheduleRuns.mockImplementation(
      async (_id, _environment, query) =>
        query?.cursor
          ? { runs: [{ id: "older-run" }], nextCursor: null }
          : { runs: [{ id: "latest-run" }], nextCursor: "older" },
    );
    await controller.load();
    await controller.select("paused");
    await controller.olderRuns();
    const runs = controller.snapshot().runs;
    client.listScheduleRuns.mockClear();
    await controller.filter("", "all");
    expect(controller.snapshot()).toMatchObject({
      selectedId: "paused",
      runsCursor: "older",
      runsPreviousCursors: [null],
    });
    expect(controller.snapshot().runs).toBe(runs);
    expect(client.listScheduleRuns).not.toHaveBeenCalled();
  });

  test("the automatic editor keeps its identity while list polling refreshes jobs", async () => {
    const { controller, client, poll } = harness();
    await activate(controller);
    const editor = controller.snapshot().editor;
    client.listSchedules.mockResolvedValue({
      jobs: [job("active", "paused"), job("new", "active")],
    });
    poll();
    await vi.waitFor(() =>
      expect(client.listSchedules).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() => expect(controller.snapshot().jobs).toHaveLength(2));
    expect(controller.snapshot().editor).toBe(editor);
    expect(controller.snapshot().jobs[0]).toMatchObject({
      id: "active",
      state: "paused",
    });
    controller.setActive(false);
  });

  test("a pending history read does not block the editor or list polls and is not duplicated", async () => {
    const { controller, client, poll, render } = harness();
    const pending = deferred<{ runs: { id: string }[] }>();
    client.listScheduleRuns.mockReturnValue(pending.promise);
    controller.setActive(true);
    await vi.waitFor(() => expect(controller.snapshot().loading).toBe(false));
    const editor = controller.snapshot().editor;
    expect(editor.job.id).toBe("active");
    expect(render).toHaveBeenLastCalledWith(
      expect.objectContaining({ loading: false, editor }),
    );
    for (const expectedReads of [2, 3]) {
      poll();
      await vi.waitFor(() =>
        expect(client.listSchedules).toHaveBeenCalledTimes(expectedReads),
      );
      await vi.waitFor(() => expect(controller.snapshot().loading).toBe(false));
    }
    expect(client.listScheduleRuns).toHaveBeenCalledOnce();
    expect(controller.snapshot().editor).toBe(editor);
    controller.setActive(false);
    pending.resolve({ runs: [{ id: "late" }] });
    await Promise.resolve();
    expect(controller.snapshot().runs).not.toEqual([{ id: "late" }]);
  });

  test("foreground history navigation supersedes a pending background page refresh", async () => {
    const { controller, client } = harness();
    client.listScheduleRuns.mockImplementation(
      async (_id, _environment, query) =>
        query?.cursor
          ? { runs: [{ id: "older-run" }], nextCursor: null }
          : { runs: [{ id: "latest-run" }], nextCursor: "older" },
    );
    await controller.load();
    await controller.select("paused");
    await controller.olderRuns();
    const pending = deferred<{ runs: { id: string }[] }>();
    client.listScheduleRuns.mockReturnValueOnce(pending.promise);
    const background = controller.load({ background: true });
    await vi.waitFor(() =>
      expect(client.listScheduleRuns).toHaveBeenCalledTimes(3),
    );
    await controller.newerRuns();
    expect(controller.snapshot()).toMatchObject({
      selectedId: "paused",
      runsCursor: null,
      runs: [{ id: "latest-run" }],
    });
    pending.resolve({ runs: [{ id: "stale-older-run" }] });
    await background;
    await Promise.resolve();
    expect(controller.snapshot().runs).toEqual([{ id: "latest-run" }]);
  });

  test("explicit refresh replaces pending history while timer polling deduplicates it", async () => {
    const { controller, client, poll, render } = harness();
    const pending = deferred<{ runs: { id: string }[] }>();
    client.listScheduleRuns.mockReturnValueOnce(pending.promise);
    await activate(controller);
    expect(client.listScheduleRuns).toHaveBeenCalledOnce();
    render.mockClear();
    poll();
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    expect(client.listSchedules).toHaveBeenCalledTimes(2);
    expect(client.listScheduleRuns).toHaveBeenCalledOnce();
    await controller.load();
    expect(client.listScheduleRuns).toHaveBeenCalledTimes(2);
    await vi.waitFor(() =>
      expect(controller.snapshot().runs).toEqual([{ id: "run-1" }]),
    );
    pending.resolve({ runs: [{ id: "stale-run" }] });
    await Promise.resolve();
    expect(controller.snapshot().runs).toEqual([{ id: "run-1" }]);
    controller.setActive(false);
  });

  test("a direct job opens before its initial history settles without claiming empty history", async () => {
    const { controller, client } = harness();
    const pending = deferred<{ runs: { id: string }[] }>();
    client.listScheduleRuns.mockReturnValueOnce(pending.promise);
    await controller.openJob("active");
    expect(controller.snapshot()).toMatchObject({
      selectedId: "active",
      editor: null,
      loading: false,
      loadingRuns: true,
      runs: [],
    });
    pending.resolve({ runs: [] });
    await vi.waitFor(() =>
      expect(controller.snapshot().loadingRuns).toBe(false),
    );
    expect(controller.snapshot().runs).toEqual([]);
  });

  test("opens the first visible current schedule in its edit form on entry", async () => {
    const { controller, client } = harness();
    await activate(controller);
    expect(controller.snapshot()).toMatchObject({
      filter: "current",
      selectedId: "active",
      editor: { job: { id: "active" }, environmentId: "dev" },
    });
    expect(client.listScheduleRuns).toHaveBeenCalledOnce();
    expect(client.listScheduleRuns).toHaveBeenCalledWith("active", "dev", {
      cursor: undefined,
    });
  });

  test("does not edit hidden completed schedules when Current has no matches", async () => {
    const { controller, client } = harness([job("finished", "completed")]);
    await activate(controller);
    expect(controller.snapshot()).toMatchObject({
      selectedId: "",
      editor: null,
    });
    expect(client.listScheduleRuns).not.toHaveBeenCalled();
  });

  test("filter changes select visible details and empty matches never fetch missing run history", async () => {
    const { controller, client } = harness();
    await activate(controller);
    controller.cancelEdit();
    await controller.filter("", "completed");
    expect(controller.snapshot()).toMatchObject({
      selectedId: "finished",
      editor: null,
    });
    client.listScheduleRuns.mockClear();
    await controller.filter("absent", "current");
    expect(controller.snapshot()).toMatchObject({
      selectedId: "",
      runs: [],
      editor: null,
      loadingRuns: false,
    });
    expect(client.listScheduleRuns).not.toHaveBeenCalled();
    await controller.filter("paused", "current");
    expect(controller.snapshot().selectedId).toBe("paused");
  });

  test("direct completed links reveal their exact job without opening an editor", async () => {
    const { controller, client } = harness();
    controller.setActive(true);
    await controller.openJob("finished");
    expect(controller.snapshot()).toMatchObject({
      query: "",
      filter: "all",
      selectedId: "finished",
      editor: null,
    });
    expect(client.listScheduleRuns).toHaveBeenCalledOnce();
    expect(client.listScheduleRuns).toHaveBeenCalledWith("finished", "dev", {
      cursor: undefined,
    });
  });

  test("missing direct links preserve unavailable identity without requesting missing run history", async () => {
    const { controller, client } = harness();
    await controller.openJob("removed");
    expect(controller.snapshot()).toMatchObject({
      filter: "all",
      selectedId: "removed",
      editor: null,
      runs: [],
    });
    expect(client.listScheduleRuns).not.toHaveBeenCalled();
  });

  test("cancel, save, and ordinary refresh do not reopen an editor", async () => {
    const { controller } = harness();
    await activate(controller);
    controller.cancelEdit();
    await controller.load({ background: true });
    expect(controller.snapshot().editor).toBeNull();
    controller.beginEdit("active");
    await controller.save({ title: "Updated" });
    expect(controller.snapshot().editor).toBeNull();
    await controller.load();
    expect(controller.snapshot().editor).toBeNull();
  });

  test("refresh and unguarded filtering retain the existing draft identity", async () => {
    const { controller, client } = harness();
    await activate(controller);
    const editor = controller.snapshot().editor;
    client.listSchedules.mockResolvedValue({ jobs: [job("active", "active")] });
    await controller.load();
    expect(controller.snapshot().editor).toBe(editor);
    await controller.filter("absent", "completed");
    expect(controller.snapshot().editor).toBe(editor);
    expect(controller.snapshot().selectedId).toBe("active");
  });

  test("environment entry opens only the current environment's first visible job", async () => {
    const { controller, client, changeEnvironment } = harness();
    const oldRead = deferred<{ jobs: ReturnType<typeof job>[] }>();
    client.listSchedules.mockImplementation((environmentId) =>
      environmentId === "dev"
        ? oldRead.promise
        : Promise.resolve({ jobs: [job("new", "paused")] }),
    );
    controller.setActive(true);
    changeEnvironment("other");
    await controller.load();
    oldRead.resolve({ jobs: [job("stale", "active")] });
    await Promise.resolve();
    expect(controller.snapshot()).toMatchObject({
      environmentId: "other",
      selectedId: "new",
      editor: { job: { id: "new" }, environmentId: "other" },
    });
    expect(client.listScheduleRuns).toHaveBeenCalledOnce();
    expect(client.listScheduleRuns).toHaveBeenCalledWith("new", "other", {
      cursor: undefined,
    });
  });

  test("a pending entry read cannot open an editor after leaving the screen", async () => {
    const { controller, client, render } = harness();
    const pending = deferred<{ jobs: ReturnType<typeof job>[] }>();
    client.listSchedules.mockReturnValue(pending.promise);
    controller.setActive(true);
    controller.setActive(false);
    render.mockClear();
    pending.resolve({ jobs: [job("active", "active")] });
    await vi.waitFor(() => expect(controller.snapshot().loading).toBe(false));
    expect(controller.snapshot().editor).toBeNull();
    expect(render).not.toHaveBeenCalled();
  });

  test.each(["entry", "direct"])(
    "a late %s read respects a newer filter selection",
    async (source) => {
      const { controller, client } = harness();
      await controller.load();
      const pending = deferred<{ jobs: ReturnType<typeof job>[] }>();
      client.listSchedules.mockReturnValue(pending.promise);
      const opening =
        source === "direct"
          ? controller.openJob("finished")
          : controller.setActive(true);
      await controller.filter("paused", "current");
      pending.resolve({
        jobs: [
          job("finished", "completed"),
          job("active", "active"),
          job("paused", "paused"),
        ],
      });
      await opening;
      await vi.waitFor(() => expect(controller.snapshot().loading).toBe(false));
      expect(controller.snapshot()).toMatchObject({
        query: "paused",
        filter: "current",
        selectedId: "paused",
        editor: null,
      });
    },
  );

  test("a fresh environment restores Current while re-entry retains the chosen same-environment filter", async () => {
    const { controller, changeEnvironment } = harness();
    await activate(controller);
    controller.cancelEdit();
    await controller.filter("", "completed");
    controller.setActive(false);
    await activate(controller);
    expect(controller.snapshot()).toMatchObject({
      filter: "completed",
      selectedId: "finished",
      editor: { job: { id: "finished" } },
    });
    changeEnvironment("other");
    await controller.load();
    expect(controller.snapshot()).toMatchObject({
      query: "",
      filter: "current",
      selectedId: "active",
      editor: { job: { id: "active" }, environmentId: "other" },
    });
  });

  test("a late detail read cannot replace the selected filter's run history", async () => {
    const { controller, client } = harness();
    await controller.load();
    const pending = deferred<{ runs: { id: string }[] }>();
    client.listScheduleRuns.mockReturnValueOnce(pending.promise);
    const earlier = controller.select("active");
    await controller.filter("", "completed");
    pending.resolve({ runs: [{ id: "stale-run" }] });
    await earlier;
    expect(controller.snapshot()).toMatchObject({
      selectedId: "finished",
      runs: [{ id: "run-1" }],
    });
  });
});
