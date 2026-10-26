import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createDashboardController } from "../../web-ui/app/controllers/dashboard-controller.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { dashboardRefreshResources } from "../../web-ui/app/lib/workspace-change.js";
import type { BasketView } from "../information-basket/contracts.js";
import { attentionSource, basketView, deferred, replacementPath, resourcesFixture } from "./support/dashboard-resources-fixture.js";

function fixture(initiallyReady = true) {
  const f = resourcesFixture({ interactive: false });
  let runtimeReady = initiallyReady;
  let active = false;
  let visible = true;
  const syncInteractive = () => f.setInteractive(runtimeReady && active && visible);
  const client = {
    ...f.client, supportsSchedules: () => true, supportsAutomations: () => true,
    listRecentScheduleRuns: vi.fn(async () => ({ runs: [] })),
    listAutomations: vi.fn(async () => ({ automations: [] })),
  };
  const loadSessions = vi.fn(async () => {});
  const approvals = { snapshot: () => ({}), refresh: vi.fn(async () => {}), invalidate: vi.fn() };
  const dashboard = createDashboardController({
    client, getEnvironmentId: f.getEnvironmentId, getSessions: () => [], loadSessions,
    render: vi.fn(), isRuntimeReady: () => runtimeReady, isVisible: () => visible,
    resourceData: f.controller, approvalData: approvals,
  });
  function setActive(value: boolean) {
    active = value; syncInteractive(); dashboard.setActive(value);
  }
  return {
    ...f, client, loadSessions, approvals, dashboard, setActive,
    async start() { dashboard.setReady(); setActive(true); await vi.advanceTimersByTimeAsync(0); },
    setRuntimeReady(value: boolean) {
      runtimeReady = value; syncInteractive(); dashboard.runtimeAvailabilityChanged();
    },
    setVisible(value: boolean) {
      visible = value; syncInteractive(); dashboard.visibilityChanged();
    },
    changeEnvironment(value: string) { f.setEnvironment(value); dashboard.environmentChanged(); },
    event(resources = ["information-basket"], environment = f.getEnvironmentId()) {
      dashboard.handleRealtime({ type: "workspace_changed", environment, resources });
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("Home Resources lifecycle", () => {
  test("waits for startup, Home and onboarding readiness before reading Resources", async () => {
    vi.useFakeTimers();
    const f = fixture(false);
    await f.dashboard.refresh();
    f.event();
    await f.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.client.listInformationBasket).not.toHaveBeenCalled();
    expect(f.loadSessions).not.toHaveBeenCalled();
    expect(await f.controller.reindex(attentionSource.sourceId)).toBe(false);
    f.setRuntimeReady(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.listInformationBasket).toHaveBeenCalledExactlyOnceWith("dev");
    expect(f.dashboard.snapshot().resourceAttention.issues).toHaveLength(1);
  });

  test("batches committed Resources notifications without polling or refreshing unrelated Home data", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.start();
    for (let index = 0; index < 10; index++) f.event();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.client.listInformationBasket).toHaveBeenCalledTimes(2);
    expect(f.client.listRecentScheduleRuns).toHaveBeenCalledTimes(1);
    expect(f.client.listAutomations).toHaveBeenCalledTimes(1);
    expect(f.loadSessions).toHaveBeenCalledTimes(1);
    expect(f.approvals.refresh).toHaveBeenCalledTimes(1);
    expect(f.client.reindexInformationBasketSource).not.toHaveBeenCalled();
    expect(f.client.relinkInformationBasketSource).not.toHaveBeenCalled();
  });

  test("ignores other environments and model activity while preserving mixed-resource selection", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.start();
    f.event(["information-basket"], "prod");
    f.event(["unknown"]);
    f.dashboard.handleRealtime({ type: "event", name: "runtime.state", phase: "information_basket.read.completed", environment: "dev" });
    f.dashboard.handleRealtime({ type: "token", environment: "dev" });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.listInformationBasket).toHaveBeenCalledTimes(1);
    f.event(["sessions", "information-basket", "unknown"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.listInformationBasket).toHaveBeenCalledTimes(2);
    expect(f.loadSessions).toHaveBeenCalledTimes(2);
    expect(f.approvals.refresh).toHaveBeenCalledTimes(1);
    expect(dashboardRefreshResources({ type: "completed", environment: "dev" }, "dev")).toEqual(["sessions", "approvals"]);
  });

  test("does not lose a resource event during an in-flight read", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.start();
    const pending = deferred<BasketView>();
    f.client.listInformationBasket.mockReturnValueOnce(pending.promise);
    f.event();
    await vi.advanceTimersByTimeAsync(100);
    for (let index = 0; index < 8; index++) f.event();
    expect(f.client.listInformationBasket).toHaveBeenCalledTimes(2);
    pending.resolve(basketView());
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.listInformationBasket).toHaveBeenCalledTimes(3);
    expect(f.loadSessions).toHaveBeenCalledTimes(1);
  });

  test.each(["hidden", "inactive"])("closes the picker and defers reads and actions while %s", async (mode) => {
    vi.useFakeTimers();
    const f = fixture();
    f.client.listInformationBasket.mockResolvedValue(basketView([{ ...attentionSource, status: "missing" }]));
    await f.start();
    await f.controller.relink(attentionSource.sourceId);
    f.controller.picker.select(replacementPath);
    expect(f.attention().picker.open).toBe(true);
    f.event();
    if (mode === "hidden") f.setVisible(false); else f.setActive(false);
    f.event();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.attention().picker.open).toBe(false);
    expect(await f.controller.picker.submit([replacementPath])).toBe(false);
    expect(f.client.relinkInformationBasketSource).not.toHaveBeenCalled();
    expect(f.client.listInformationBasket).toHaveBeenCalledTimes(1);
    if (mode === "hidden") f.setVisible(true); else f.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.listInformationBasket).toHaveBeenCalledTimes(2);
    expect(f.attention().picker.open).toBe(false);
  });

  test("environment changes clear old source state and reject a late metadata response", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.start();
    const old = deferred<BasketView>();
    f.client.listInformationBasket.mockReturnValueOnce(old.promise).mockResolvedValue(basketView([]));
    const read = f.dashboard.refresh();
    f.changeEnvironment("prod");
    await vi.advanceTimersByTimeAsync(0);
    old.resolve(basketView());
    await read;
    expect(f.dashboard.snapshot().resourceAttention).toMatchObject({ issues: [], picker: { open: false }, error: "" });
    expect(f.client.listInformationBasket.mock.calls.at(-1)).toEqual(["prod"]);
  });

  test("onboarding reset invalidates an active mutation and resumes with a fresh metadata read only", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.start();
    const pending = deferred<BasketView>();
    f.client.reindexInformationBasketSource.mockReturnValueOnce(pending.promise);
    const action = f.controller.reindex(attentionSource.sourceId);
    f.setRuntimeReady(false);
    expect(f.attention()).toMatchObject({ issues: [], mutation: "", picker: { open: false } });
    f.event();
    pending.resolve(basketView());
    expect(await action).toBe(false);
    expect(f.notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.listInformationBasket).toHaveBeenCalledTimes(1);
    f.setRuntimeReady(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.listInformationBasket).toHaveBeenCalledTimes(2);
    expect(f.client.reindexInformationBasketSource).toHaveBeenCalledOnce();
  });
});
