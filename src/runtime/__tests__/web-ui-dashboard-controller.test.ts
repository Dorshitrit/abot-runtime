import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createDashboardController } from "../../web-ui/app/controllers/dashboard-controller.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { renderDashboardActivity } from "../../web-ui/app/components/dashboard/activity.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  let environmentId = "dev";
  let sessions = [{ id: "dev-session", unreadCount: 2 }];
  let supported = true;
  const client = {
    supportsSchedules: () => supported,
    listRecentScheduleRuns: vi.fn(
      async (): Promise<{ runs: { id: string }[] }> => ({ runs: [] }),
    ),
  };
  const loadSessions = vi.fn(async () => {});
  const controller = createDashboardController({
    client,
    getEnvironmentId: () => environmentId,
    getSessions: () => sessions,
    loadSessions,
    render: vi.fn(),
    isVisible: () => true,
    setTimer: vi.fn(),
    clearTimer: vi.fn(),
  });
  return {
    controller,
    client,
    loadSessions,
    setEnvironment: (value: string) => {
      environmentId = value;
    },
    setSessions: (value: typeof sessions) => {
      sessions = value;
    },
    setSupported: (value: boolean) => {
      supported = value;
    },
  };
}

describe("Dashboard read lifecycle", () => {
  it("waits for readiness and handles the canonical session-list status callbacks", async () => {
    const f = fixture();
    f.controller.setActive(true);
    expect(f.loadSessions).not.toHaveBeenCalled();
    f.controller.setReady();
    await vi.waitFor(() =>
      expect(f.controller.snapshot().loadingActivity).toBe(false),
    );
    expect(f.client.listRecentScheduleRuns).toHaveBeenCalledWith("dev", {
      limit: 8,
    });
    expect(f.controller.snapshot().sessions).toEqual([]);
    f.controller.sessionsChanged({ status: "loading", sessions: [] });
    expect(f.controller.snapshot().loadingSessions).toBe(true);
    f.controller.sessionsChanged({ status: "ready" });
    expect(f.controller.snapshot()).toMatchObject({
      loadingSessions: false,
      sessionsError: "",
      sessions: [{ id: "dev-session", unreadCount: 2 }],
    });
    f.controller.sessionsChanged({ status: "error", error: "Read failed" });
    expect(f.controller.snapshot()).toMatchObject({
      loadingSessions: false,
      sessionsError: "Read failed",
    });
  });

  it("hides previous-environment conversations until a current ready list and discards old activity", async () => {
    const f = fixture();
    const oldRead = deferred<{ runs: { id: string }[] }>();
    f.client.listRecentScheduleRuns.mockReturnValueOnce(oldRead.promise);
    f.client.listRecentScheduleRuns.mockResolvedValueOnce({
      runs: [{ id: "prod-run" }],
    });
    f.controller.sessionsChanged({ status: "ready" });
    f.controller.setReady();
    f.controller.setActive(true);
    f.setEnvironment("prod");
    f.controller.environmentChanged();
    expect(f.controller.snapshot().sessions).toEqual([]);
    expect(f.controller.snapshot().loadingSessions).toBe(true);
    await vi.waitFor(() =>
      expect(f.controller.snapshot().runs).toEqual([{ id: "prod-run" }]),
    );
    oldRead.resolve({ runs: [{ id: "old-run" }] });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.controller.snapshot().runs).toEqual([{ id: "prod-run" }]);
    expect(f.controller.snapshot().sessions).toEqual([]);
    f.setSessions([{ id: "prod-session", unreadCount: 1 }]);
    f.controller.sessionsChanged({ status: "ready" });
    expect(f.controller.snapshot().sessions).toEqual([
      { id: "prod-session", unreadCount: 1 },
    ]);
  });

  it("surfaces an initial activity failure without presenting it as empty activity", async () => {
    const f = fixture();
    f.client.listRecentScheduleRuns.mockRejectedValueOnce(
      new Error("Owner unavailable"),
    );
    f.controller.setReady();
    f.controller.setActive(true);
    await vi.waitFor(() =>
      expect(f.controller.snapshot().activityError).toBe("Owner unavailable"),
    );
    const snapshot = f.controller.snapshot();
    const markup = renderDashboardActivity({
      runs: snapshot.runs,
      error: snapshot.activityError,
      loading: snapshot.loadingActivity,
      supported: true,
    });
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain('data-dashboard-action="template"');
    expect(snapshot.loadingActivity).toBe(false);
  });

  it("retains the last successful activity on refresh failure and clears it when unsupported", async () => {
    const f = fixture();
    f.client.listRecentScheduleRuns.mockResolvedValueOnce({
      runs: [{ id: "saved-run" }],
    });
    f.controller.setReady();
    f.controller.setActive(true);
    await vi.waitFor(() =>
      expect(f.controller.snapshot().runs).toHaveLength(1),
    );
    f.client.listRecentScheduleRuns.mockRejectedValueOnce(
      new Error("Refresh unavailable"),
    );
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({
      runs: [{ id: "saved-run" }],
      activityError: "Refresh unavailable",
      loadingActivity: false,
    });
    f.setSupported(false);
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({
      runs: [],
      supportsSchedules: false,
    });
  });
});
