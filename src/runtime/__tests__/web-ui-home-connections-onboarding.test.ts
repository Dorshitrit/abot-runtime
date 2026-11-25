import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser composition has no declaration surface.
import { createDashboardFeature } from "../../web-ui/app/dashboard-feature.js";
import { createHomeWidgetsHarness, type HomeWidgetElement } from "./support/home-widgets-harness.js";

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).reverse().forEach(dispose => dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const server = (phase = "ready") => ({
  phase, configured: true, supported: true, busy: false, installation: "installed", ownsProcess: true,
  revision: "a".repeat(32), models: [],
  settings: { startup: "manual", port: 8080, sleepIdleSeconds: 60, maxLoadedModels: 2,
    models: [], embedding: null },
});
async function settle() { for (let index = 0; index < 20; index++) await Promise.resolve(); }

function fixture(initialReady = false, width = 1600) {
  vi.useFakeTimers();
  const h = createHomeWidgetsHarness(width);
  Object.assign(h.documentRoot, { visibilityState: "visible" });
  vi.stubGlobal("document", h.documentRoot);
  let ready = initialReady;
  const client = {
    supportsSchedules: () => false, supportsAutomations: () => false,
    supportsToolApprovals: () => false, supportsInformationBasket: () => false,
    getManagedLlamaServer: vi.fn(async (_environment: string) => ({ server: server() })),
    managedLlamaServerAction: vi.fn(),
    getSocketConnection: vi.fn(async () => ({ connection: { state: "not_configured", localEnvironmentId: "dev" } })),
  };
  const feature = createDashboardFeature({
    dom: { homeDashboardRoot: h.root, modelSelect: { value: "model" } },
    state: { sessions: [], config: { backend: "runtime" } }, client,
    shell: { activeWorkspace: () => "home", activateWorkspace: vi.fn(), showToast: vi.fn(), setSessionsDrawerOpen: vi.fn() },
    schedules: { createJob: vi.fn() }, selectedEnvironmentId: () => "dev",
    loadSessions: vi.fn(async () => {}), openSession: vi.fn(), isComposerAvailable: () => ready,
  });
  disposers.push(() => { feature.setActive(false); feature.compactWidgets.dispose(); });
  const node = (selector: string) => h.root.querySelector(selector) as HomeWidgetElement;
  const panel = node("[data-home-llama]");
  const button = panel.querySelector("button") as HomeWidgetElement;
  return {
    ...h, feature, client, panel, button,
    connections: node(".home-connections"), setup: node("[data-dashboard-setup]"),
    status: () => button.querySelector("[data-connection-status]")!.textContent,
    llamaDialog: () => h.documentRoot.body.querySelector(".llama-server-dialog") as HomeWidgetElement | null,
    async start() { feature.setActive(true); feature.setReady(); await settle(); },
    async setReady(value: boolean) { ready = value; feature.runtimeAvailabilityChanged(); await settle(); },
    async open() { button.focus(); button.dispatch("click"); await settle(); },
  };
}

test("llama Home access follows onboarding readiness and closes its popup on re-entry", async () => {
  const h = fixture();
  await h.start();
  expect(h.setup.hidden).toBe(false);
  expect(h.panel.hidden).toBe(true);
  expect(h.client.getManagedLlamaServer).not.toHaveBeenCalled();
  await h.open();
  expect(h.llamaDialog()?.open).not.toBe(true);
  expect(h.client.getManagedLlamaServer).not.toHaveBeenCalled();

  await h.setReady(true);
  expect(h.setup.hidden).toBe(true);
  expect(h.panel.hidden).toBe(false);
  expect(h.connections.hidden).toBe(false);
  expect(h.client.getManagedLlamaServer).toHaveBeenCalledExactlyOnceWith("dev");
  await h.open();
  expect(h.llamaDialog()?.open).toBe(true);
  const calls = h.client.getManagedLlamaServer.mock.calls.length;

  await h.setReady(false);
  expect(h.setup.hidden).toBe(false);
  expect(h.panel.hidden).toBe(true);
  expect(h.connections.hidden).toBe(true);
  expect(h.llamaDialog()?.open).toBe(false);
  await h.open();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.llamaDialog()?.open).toBe(false);
  expect(h.client.getManagedLlamaServer).toHaveBeenCalledTimes(calls);
  expect(h.client.managedLlamaServerAction).not.toHaveBeenCalled();

  await h.setReady(true);
  expect(h.panel.hidden).toBe(false);
  expect(h.connections.hidden).toBe(false);
  expect(h.client.getManagedLlamaServer).toHaveBeenCalledTimes(calls + 1);
});

test("a delayed llama status cannot update or restart Home polling after onboarding returns", async () => {
  const h = fixture(true);
  await h.start();
  expect(h.status()).toBe("Running");
  let resolve!: (value: { server: ReturnType<typeof server> }) => void;
  const pending = new Promise<{ server: ReturnType<typeof server> }>(done => { resolve = done; });
  h.client.getManagedLlamaServer.mockImplementationOnce(() => pending);
  await vi.advanceTimersByTimeAsync(10_000);
  const calls = h.client.getManagedLlamaServer.mock.calls.length;
  await h.setReady(false);
  resolve({ server: server("stopped") });
  await settle();
  expect(h.panel.hidden).toBe(true);
  expect(h.connections.hidden).toBe(true);
  expect(h.status()).toBe("Running");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.client.getManagedLlamaServer).toHaveBeenCalledTimes(calls);
  await h.setReady(true);
  expect(h.panel.hidden).toBe(false);
  expect(h.status()).toBe("Running");
  expect(h.client.getManagedLlamaServer).toHaveBeenCalledTimes(calls + 1);
});

test.each([1280, 1600])("Home Connections stay hidden during onboarding at width %s even if a child unhides", async width => {
  const h = fixture(false, width);
  expect(h.connections.hidden).toBe(true);
  await h.start();
  h.panel.hidden = false;
  expect(h.connections.hidden).toBe(true);
  expect(h.setup.hidden).toBe(false);
  await h.setReady(true);
  expect(h.connections.hidden).toBe(false);
  await h.setReady(false);
  h.panel.hidden = false;
  expect(h.connections.hidden).toBe(true);
  expect(h.setup.hidden).toBe(false);
});
