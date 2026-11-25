import { afterEach, expect, test, vi } from "vitest";
import { createHomeWidgetsHarness, type HomeWidgetElement } from "./support/home-widgets-harness.js";
// @ts-expect-error Browser composition has no declaration surface.
import { createSocketConnectionFeature } from "../../web-ui/app/components/socket-connection/feature.js";
// @ts-expect-error Browser composition has no declaration surface.
import { createManagedServerHome } from "../../web-ui/app/components/managed-llama-server/home.js";

const socket = (state = "connected", localEnvironmentId = "dev") => ({
  state, localEnvironmentId, revision: 1, source: "managed", remoteRuntimeId: "studio",
  serverOrigin: "wss://socket.test", error: null,
});
const settings = {
  startup: "manual", port: 8080, sleepIdleSeconds: 60, maxLoadedModels: 2,
  models: [{ alias: "chat", modelPath: "/synthetic/model.gguf", contextTokens: 4096, gpuLayers: 0 }], embedding: null,
};
const server = (extra: Record<string, unknown> = {}) => ({
  phase: "ready", configured: true, supported: true, busy: false, installation: "installed", ownsProcess: true,
  settings: structuredClone(settings), revision: "a".repeat(32), models: [{ alias: "chat", state: "sleeping" }], ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
const stops: Array<() => void> = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

function fixture(kind: "socket" | "llama") {
  vi.useFakeTimers();
  const h = createHomeWidgetsHarness();
  const panel = h.createElement("section");
  h.root.append(panel);
  let environment = "dev";
  const client = {
    getSocketConnection: vi.fn(async (_environment: string) => ({ connection: socket() })),
    changeSocketConnection: vi.fn(), previewSocketConnection: vi.fn(),
    getManagedLlamaServer: vi.fn(async (_environment: string) => ({ server: server() })),
    managedLlamaServerAction: vi.fn(async () => ({ server: server() })),
  };
  const options = { panel, client, getEnvironmentId: () => environment, supported: () => true,
    ready: () => true, documentRoot: h.documentRoot, page: h.viewport };
  const feature = kind === "socket" ? createSocketConnectionFeature(options) : createManagedServerHome(options);
  stops.push(() => feature.setActive(false));
  const button = panel.querySelector("button") as HomeWidgetElement;
  const status = () => button.querySelector("[data-connection-status]")!;
  const dialog = () => h.documentRoot.body.querySelector(kind === "socket" ? ".socket-connection-dialog" : ".llama-server-dialog") as HomeWidgetElement;
  return { ...h, panel, client, feature, button, status, dialog,
    setEnvironment(value: string) { environment = value; feature.sync(); },
    async start() { feature.setActive(true); await settle(); },
    async open() { button.focus(); button.querySelector("[data-connection-detail]")!.dispatch("click"); await settle(); },
  };
}

test.each(["socket", "llama"] as const)("%s renders one stable whole-card popup trigger without writing", async kind => {
  const h = fixture(kind);
  await h.start();
  expect(h.panel.querySelectorAll("button")).toHaveLength(1);
  expect(h.button.getAttribute("aria-haspopup")).toBe("dialog");
  expect(h.button.hasAttribute("aria-expanded")).toBe(false);
  expect(h.status().dataset.tone).toBe("success");
  await h.open();
  expect(h.dialog().open).toBe(true);
  expect(h.panel.querySelector("button")).toBe(h.button);
  expect(h.client.changeSocketConnection).not.toHaveBeenCalled();
  expect(h.client.managedLlamaServerAction).not.toHaveBeenCalled();
  h.dialog().dispatch("cancel");
  expect(h.dialog().open).toBe(false);
  expect(h.documentRoot.activeElement).toBe(h.button);
});

test.each([
  ["connected", "Connected", "success"], ["connecting", "Connecting", "active"],
  ["reconnecting", "Reconnecting", "active"], ["offline", "Offline", "failed"],
  ["paused", "Paused", "neutral"], ["not_configured", "Not connected", "neutral"],
])("Socket %s has explicit status and semantic tone", async (state, label, tone) => {
  const h = fixture("socket");
  h.client.getSocketConnection.mockResolvedValue({ connection: socket(state) });
  await h.start();
  expect(h.status().textContent).toBe(label);
  expect(h.status().dataset.tone).toBe(tone);
  expect(h.panel.dataset.socketState).toBe(state);
});

test.each(["socket", "llama"] as const)("%s clears a stale healthy badge when its status request fails", async kind => {
  const h = fixture(kind);
  await h.start();
  const read = kind === "socket" ? h.client.getSocketConnection : h.client.getManagedLlamaServer;
  read.mockRejectedValueOnce({ status: 503 });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.status().textContent).toBe("Status unavailable");
  expect(h.status().dataset.tone).toBe("attention");
  expect(h.button.disabled).toBe(false);
  read.mockRejectedValueOnce({ status: 403 });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.button.disabled).toBe(true);
  expect(h.panel.hidden).toBe(false);
  const calls = read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(read).toHaveBeenCalledTimes(calls);
});

test.each([
  ["ready", "Running", "success"], ["starting", "Starting", "active"],
  ["stopping", "Stopping", "active"], ["stopped", "Stopped", "neutral"],
  ["restoring", "Checking", "active"], ["error", "Needs attention", "failed"],
])("llama %s has explicit status and semantic tone", async (phase, label, tone) => {
  const h = fixture("llama");
  h.client.getManagedLlamaServer.mockResolvedValue({ server: server({ phase }) });
  await h.start();
  expect(h.status().textContent).toBe(label);
  expect(h.status().dataset.tone).toBe(tone);
});

test("llama unknown and unsupported states never inherit a healthy badge", async () => {
  const h = fixture("llama");
  const pending = deferred<{ server: ReturnType<typeof server> }>();
  h.client.getManagedLlamaServer.mockImplementationOnce(() => pending.promise);
  h.feature.setActive(true);
  expect(h.status().textContent).toBe("Checking");
  expect(h.status().dataset.tone).toBe("neutral");
  pending.resolve({ server: server({ supported: false }) });
  await settle();
  expect(h.status().textContent).toBe("Unavailable");
  expect(h.button.disabled).toBe(true);
});

test("llama ignores an old Home poll after the popup observes newer server state", async () => {
  const h = fixture("llama");
  await h.start();
  const pending = deferred<{ server: ReturnType<typeof server> }>();
  h.client.getManagedLlamaServer.mockImplementationOnce(() => pending.promise);
  await vi.advanceTimersByTimeAsync(10_000);
  h.client.getManagedLlamaServer.mockResolvedValue({ server: server({ phase: "stopped", ownsProcess: false }) });
  await h.open();
  expect(h.status().textContent).toBe("Stopped");
  pending.resolve({ server: server() });
  await settle();
  expect(h.status().textContent).toBe("Stopped");
  expect(h.status().dataset.tone).toBe("neutral");
});

test("llama clears the old environment status while loading and rejects its delayed response", async () => {
  const h = fixture("llama");
  await h.start();
  const old = deferred<{ server: ReturnType<typeof server> }>();
  h.client.getManagedLlamaServer.mockImplementationOnce(() => old.promise);
  await vi.advanceTimersByTimeAsync(10_000);
  const current = deferred<{ server: ReturnType<typeof server> }>();
  h.client.getManagedLlamaServer.mockImplementationOnce(() => current.promise);
  h.setEnvironment("other");
  expect(h.status().textContent).toBe("Checking");
  old.resolve({ server: server() });
  await settle();
  expect(h.status().textContent).toBe("Checking");
  current.resolve({ server: server({ phase: "stopped" }) });
  await settle();
  expect(h.status().textContent).toBe("Stopped");
});

test("llama popup backdrop closes without discarding settings or triggering a write", async () => {
  const h = fixture("llama");
  h.client.getManagedLlamaServer.mockResolvedValue({ server: server({ phase: "stopped", ownsProcess: false }) });
  await h.start(); await h.open();
  const field = h.dialog().querySelector('[data-llama-field="sleepIdleSeconds"]')!;
  field.value = "123"; field.dispatch("input");
  Object.assign(h.dialog(), { getBoundingClientRect: () => ({ left: 100, right: 500, top: 100, bottom: 500 }) });
  const event = { target: h.dialog(), clientX: 10, clientY: 10 };
  for (const listener of h.dialog().listeners.get("click") || []) listener(event);
  expect(h.dialog().open).toBe(false);
  expect(h.documentRoot.activeElement).toBe(h.button);
  await h.open();
  expect(h.dialog().querySelector('[data-llama-field="sleepIdleSeconds"]')!.value).toBe("123");
  expect(h.client.managedLlamaServerAction).not.toHaveBeenCalled();
});

test("llama popup polling preserves keyboard focus on the current control", async () => {
  const h = fixture("llama");
  await h.start(); await h.open();
  h.dialog().querySelector('[data-llama-action="refresh"]')!.focus();
  h.client.getManagedLlamaServer.mockResolvedValue({ server: server({ phase: "stopped", ownsProcess: false }) });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(h.documentRoot.activeElement).toBe(h.dialog().querySelector('[data-llama-action="refresh"]'));
});

test("llama page suspension closes the popup and stops polling until restored", async () => {
  const h = fixture("llama");
  await h.start(); await h.open();
  h.viewport.dispatchEvent(new Event("pagehide"));
  expect(h.dialog().open).toBe(false);
  const calls = h.client.getManagedLlamaServer.mock.calls.length;
  h.feature.sync();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.client.getManagedLlamaServer).toHaveBeenCalledTimes(calls);
  h.viewport.dispatchEvent(new Event("pageshow"));
  await settle();
  expect(h.client.getManagedLlamaServer).toHaveBeenCalledTimes(calls + 1);
});
