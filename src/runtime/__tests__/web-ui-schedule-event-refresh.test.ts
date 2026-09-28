import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createSchedulesController } from "../../web-ui/app/controllers/schedules-controller.js";

afterEach(() => vi.useRealTimers());

type Runs = { runs: { id: string }[] };

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  vi.useFakeTimers();
  let visible = true;
  let environmentId = "dev";
  const job = {
    id: "job",
    state: "active",
    title: "Daily notes",
    sessionId: "session",
    schedule: { kind: "daily", at: "09:00" },
  };
  const client = {
    listSchedules: vi.fn(async () => ({ jobs: [job] })),
    listSessions: vi.fn(async () => ({ sessions: [{ id: "session" }] })),
    listModels: vi.fn(async () => ({ profiles: [] })),
    listScheduleRuns: vi.fn(async (): Promise<Runs> => ({ runs: [] })),
    scheduleAction: vi.fn(async () => ({})),
    updateSchedule: vi.fn(async () => ({ job })),
  };
  const render = vi.fn();
  const controller = createSchedulesController({
    client,
    render,
    getEnvironmentId: () => environmentId,
    isVisible: () => visible,
    openConversation: vi.fn(),
  });
  return {
    controller,
    client,
    render,
    async enter() {
      controller.setActive(true);
      await vi.advanceTimersByTimeAsync(0);
    },
    changeEnvironment(value: string) {
      environmentId = value;
      controller.environmentChanged();
    },
    setVisible(value: boolean) {
      visible = value;
      controller.visibilityChanged();
    },
  };
}

describe("schedule event refresh presentation", () => {
  test("idle has no polling and visibility return refreshes only the active workspace", async () => {
    const f = fixture();
    await f.enter();
    expect(f.client.listSchedules).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.client.listSchedules).toHaveBeenCalledOnce();
    f.setVisible(false);
    f.controller.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.client.listSchedules).toHaveBeenCalledOnce();
    f.render.mockClear();
    f.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.listSchedules).toHaveBeenCalledTimes(2);
    expect(
      f.render.mock.calls.every(([snapshot]) => snapshot.loading === false),
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    f.controller.setActive(false);
    f.setVisible(false);
    f.setVisible(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.client.listSchedules).toHaveBeenCalledTimes(2);
  });

  test("an in-flight list response cannot restart polling after the tab becomes hidden", async () => {
    const f = fixture();
    const pending = deferred<{ jobs: [] }>();
    f.client.listSchedules.mockReturnValueOnce(pending.promise);
    f.controller.setActive(true);
    f.setVisible(false);
    pending.resolve({ jobs: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.client.listSchedules).toHaveBeenCalledOnce();
  });

  test("an environment change does not wait for an old stalled automatic read", async () => {
    const f = fixture();
    const pending = deferred<{ jobs: [] }>();
    f.client.listSchedules.mockReturnValueOnce(pending.promise);
    f.controller.setActive(true);
    f.changeEnvironment("prod");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.listSchedules).toHaveBeenCalledTimes(2);
    expect(f.controller.snapshot().environmentId).toBe("prod");
    expect(f.controller.snapshot().jobs).toHaveLength(1);
    pending.resolve({ jobs: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.snapshot().jobs).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a settled empty history remains empty while its next refresh is pending", async () => {
    const f = fixture();
    await f.enter();
    const pending = deferred<Runs>();
    f.client.listScheduleRuns.mockReturnValueOnce(pending.promise);
    f.render.mockClear();
    f.controller.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(80);
    expect(f.client.listScheduleRuns).toHaveBeenCalledTimes(2);
    expect(f.controller.snapshot()).toMatchObject({
      loadingRuns: false,
      runs: [],
    });
    expect(
      f.render.mock.calls.every(([snapshot]) => snapshot.loadingRuns === false),
    ).toBe(true);
    pending.resolve({ runs: [{ id: "new-run" }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.snapshot().runs).toEqual([{ id: "new-run" }]);
  });

  test("keeps a history error visible until a background read succeeds", async () => {
    const f = fixture();
    f.client.listScheduleRuns.mockRejectedValueOnce(
      new Error("History is unavailable."),
    );
    await f.enter();
    const error = f.controller.snapshot().detailError;
    expect(error).not.toBe("");
    const pending = deferred<Runs>();
    f.client.listScheduleRuns.mockReturnValueOnce(pending.promise);
    f.render.mockClear();
    f.controller.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(80);
    expect(f.controller.snapshot()).toMatchObject({
      detailError: error,
      loadingRuns: false,
    });
    expect(
      f.render.mock.calls.every(([snapshot]) => snapshot.detailError === error),
    ).toBe(true);
    pending.resolve({ runs: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.snapshot()).toMatchObject({
      detailError: "",
      loadingRuns: false,
    });
  });

  test.each(["action", "save"])(
    "a resource event during %s's captured read is refreshed after mutation settles",
    async (kind) => {
      const f = fixture();
      await f.enter();
      const oldJobs = f.controller.snapshot().jobs;
      const pending = deferred<{ jobs: typeof oldJobs }>();
      f.client.listSchedules.mockReturnValueOnce(pending.promise);
      if (kind === "save") f.controller.beginEdit("job");
      const mutation =
        kind === "save"
          ? f.controller.save({ title: "Saved" })
          : f.controller.action("job", "pause");
      await vi.advanceTimersByTimeAsync(0);
      expect(f.client.listSchedules).toHaveBeenCalledTimes(2);
      f.client.listSchedules.mockResolvedValue({
        jobs: [{ ...oldJobs[0], title: "Latest server value" }],
      });
      f.controller.scheduleRefresh();
      pending.resolve({ jobs: oldJobs });
      await mutation;
      await vi.advanceTimersByTimeAsync(0);
      expect(f.client.listSchedules).toHaveBeenCalledTimes(3);
      expect(f.controller.snapshot().jobs[0].title).toBe("Latest server value");
    },
  );

  test("environment invalidation retained during a mutation loads the new scope after settlement", async () => {
    const f = fixture();
    await f.enter();
    const pending = deferred<object>();
    f.client.scheduleAction.mockReturnValueOnce(pending.promise);
    const mutation = f.controller.action("job", "pause");
    f.changeEnvironment("prod");
    expect(f.client.listSchedules).toHaveBeenCalledOnce();
    pending.resolve({});
    await mutation;
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.listSchedules).toHaveBeenCalledTimes(2);
    expect(f.controller.snapshot()).toMatchObject({
      environmentId: "prod",
      loading: false,
    });
  });

  test("visibility and resource events do not overlap a schedule mutation", async () => {
    const f = fixture();
    await f.enter();
    const pending = deferred<object>();
    f.client.scheduleAction.mockReturnValueOnce(pending.promise);
    const action = f.controller.action("job", "pause");
    f.setVisible(false);
    f.setVisible(true);
    f.controller.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(80);
    expect(f.client.listSchedules).toHaveBeenCalledOnce();
    pending.resolve({});
    await action;
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.listSchedules).toHaveBeenCalledTimes(3);
  });
});
