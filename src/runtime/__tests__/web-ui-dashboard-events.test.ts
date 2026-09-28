import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createDashboardController } from "../../web-ui/app/controllers/dashboard-controller.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createDashboardApprovalsController } from "../../web-ui/app/controllers/dashboard-approvals-controller.js";
// @ts-expect-error Browser-only module has no declaration surface.
import * as workspaceChange from "../../web-ui/app/lib/workspace-change.js";
const { isWorkspaceChange, dashboardRefreshResources } = workspaceChange;

function fixture() {
  let visible = true;
  let environmentId = "dev";
  const client = {
    supportsSchedules: () => true,
    supportsToolApprovals: () => true,
    listRecentScheduleRuns: vi.fn(async () => ({ runs: [] })),
    listToolApprovals: vi.fn(async () => ({ approvals: [] })),
  };
  const render = vi.fn();
  const loadSessions = vi.fn(async () => {});
  const approvalData = createDashboardApprovalsController({
    client,
    getEnvironmentId: () => environmentId,
    render,
  });
  const controller = createDashboardController({
    client,
    getEnvironmentId: () => environmentId,
    getSessions: () => [],
    isVisible: () => visible,
    loadSessions,
    render,
    approvalData,
  });
  return {
    controller,
    client,
    loadSessions,
    approvalData,
    setVisible: (value: boolean) => {
      visible = value;
    },
    setEnvironment: (value: string) => {
      environmentId = value;
    },
    async start() {
      controller.setReady();
      controller.setActive(true);
      await vi.advanceTimersByTimeAsync(0);
    },
    event(resources: string[], scope = environmentId) {
      controller.handleRealtime({
        type: "workspace_changed",
        environment: scope,
        resources,
      });
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("Home server-driven reads", () => {
  it("performs no idle polling and batches only the affected resource", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.loadSessions).toHaveBeenCalledTimes(1);
    expect(f.client.listRecentScheduleRuns).toHaveBeenCalledTimes(1);
    expect(f.client.listToolApprovals).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 10; index++) f.event(["approvals"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.listToolApprovals).toHaveBeenCalledTimes(2);
    expect(f.loadSessions).toHaveBeenCalledTimes(1);
    expect(f.client.listRecentScheduleRuns).toHaveBeenCalledTimes(1);
    f.controller.handleRealtime({
      type: "event",
      name: "scheduler.changed",
      environment: "dev",
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.loadSessions).toHaveBeenCalledTimes(2);
    expect(f.client.listRecentScheduleRuns).toHaveBeenCalledTimes(2);
    expect(f.client.listToolApprovals).toHaveBeenCalledTimes(2);
  });

  it("ignores unrelated, foreign, hidden and inactive events; refreshes on return", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.start();
    f.event(["approvals"], "prod");
    f.event(["unknown"]);
    f.controller.handleRealtime({ type: "token", environment: "dev" });
    f.controller.handleRealtime({
      type: "event",
      name: "thinking.delta",
      environment: "dev",
    });
    f.setVisible(false);
    f.controller.visibilityChanged();
    f.event(["approvals"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.client.listToolApprovals).toHaveBeenCalledTimes(1);
    f.setVisible(true);
    f.controller.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.listToolApprovals).toHaveBeenCalledTimes(2);
    f.controller.setActive(false);
    f.event(["approvals"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.listToolApprovals).toHaveBeenCalledTimes(2);
    f.controller.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.listToolApprovals).toHaveBeenCalledTimes(3);
  });

  it("retains settled empty state and errors while a background read is pending", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.start();
    f.controller.sessionsChanged({ status: "ready" });
    f.client.listRecentScheduleRuns.mockRejectedValueOnce(new Error("Offline"));
    f.client.listToolApprovals.mockRejectedValueOnce(new Error("Offline"));
    await f.controller.refresh();
    let finishActivity!: (value: { runs: never[] }) => void;
    let finishApprovals!: (value: { approvals: never[] }) => void;
    f.client.listRecentScheduleRuns.mockReturnValueOnce(
      new Promise((resolve) => {
        finishActivity = resolve;
      }),
    );
    f.client.listToolApprovals.mockReturnValueOnce(
      new Promise((resolve) => {
        finishApprovals = resolve;
      }),
    );
    const pending = f.controller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    f.controller.sessionsChanged({ status: "loading" });
    expect(f.controller.snapshot()).toMatchObject({
      loadingActivity: false,
      activityError: "Offline",
      loadingSessions: false,
      loadingApprovals: false,
      approvalsError: "Offline",
    });
    finishActivity({ runs: [] });
    finishApprovals({ approvals: [] });
    await pending;
    expect(f.controller.snapshot()).toMatchObject({
      activityError: "",
      approvalsError: "",
    });
  });

  it("does not lose a later resource change during an in-flight refresh", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.start();
    let finish!: (value: { approvals: never[] }) => void;
    f.client.listToolApprovals.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    f.event(["approvals"]);
    await vi.advanceTimersByTimeAsync(100);
    for (let index = 0; index < 10; index++) f.event(["sessions"]);
    expect(f.loadSessions).toHaveBeenCalledTimes(1);
    finish({ approvals: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.loadSessions).toHaveBeenCalledTimes(2);
    expect(f.client.listToolApprovals).toHaveBeenCalledTimes(2);
  });

  it("refreshes conversations on persisted message events, not model progress", () => {
    expect(
      dashboardRefreshResources(
        { type: "event", name: "session.messages.updated", environment: "dev" },
        "dev",
      ),
    ).toEqual(["sessions"]);
    expect(
      dashboardRefreshResources(
        { type: "event", name: "thinking.started", environment: "dev" },
        "dev",
      ),
    ).toEqual([]);
    expect(
      dashboardRefreshResources(
        {
          type: "event",
          name: "runtime.state",
          stage: "tool",
          environment: "dev",
        },
        "dev",
      ),
    ).toEqual([]);
  });

  it("identifies workspace-only frames separately from request activity", () => {
    expect(isWorkspaceChange({ type: "workspace_changed" })).toBe(true);
    expect(
      isWorkspaceChange({ type: "event", name: "session.messages.updated" }),
    ).toBe(true);
    expect(
      isWorkspaceChange({ type: "event", name: "scheduler.changed" }),
    ).toBe(true);
    expect(
      isWorkspaceChange({ type: "event", name: "tool.approval.required" }),
    ).toBe(false);
  });

  it("keeps environment learning updates out of conversation activity", () => {
    expect(isWorkspaceChange({ type: "learning.changed", environmentId: "dev" })).toBe(true);
  });
});
