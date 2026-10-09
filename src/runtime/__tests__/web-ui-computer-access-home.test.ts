import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser composition module has no declaration surface.
import { createComputerAccessFeature } from "../../web-ui/app/computer-access-feature.js";
// @ts-expect-error Browser onboarding policy has no declaration surface.
import { createOnboardingWorkspaceAccess } from "../../web-ui/app/components/onboarding-workspace-access.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

const setupNeeded = {
  paired: false,
  connected: false,
  readiness: {
    ready: false,
    route: "setup_required",
    environment: "container",
    platforms: ["macos", "windows"],
    localSetupAvailable: false,
    restartRequired: false,
  },
};
const ready = {
  ...setupNeeded,
  paired: true,
  connected: true,
  hostId: "home-computer",
  identity: { name: "Alice's Mac", os: "macos", user: "alice" },
  readiness: { ...setupNeeded.readiness, ready: true, route: "companion", platforms: [] },
};

class HomeElement extends FakeElement {
  scrollIntoView = vi.fn();
  click = vi.fn(() => { this.dispatch("click"); });
  insertBefore(node: FakeElement, reference: FakeElement | null) {
    node.remove();
    const index = reference ? this.children.indexOf(reference) : -1;
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
    node.parentElement = this;
    return node;
  }
  before(node: FakeElement) {
    (this.parentElement as HomeElement | null)?.insertBefore(node, this);
  }
  prepend(node: FakeElement) {
    this.insertBefore(node, this.children[0] as FakeElement || null);
  }
  removeEventListener(name: string, listener: (event: any) => void) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter((entry) => entry !== listener));
  }
}

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
});

function homeHarness({ hidden = false, supported = true, runtimeReady = true, snapshot = ready as typeof setupNeeded } = {}) {
  vi.useFakeTimers();
  let environment = "prod";
  const workspaceAccess = createOnboardingWorkspaceAccess({ dom: {}, backendAllows: () => true });
  workspaceAccess.update({ status: runtimeReady ? "ready" : "setup_required" });
  const observers: Array<{ callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  class Observer {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(readonly callback: () => void) { observers.push(this); }
  }
  const listeners = new Map<string, () => void>();
  const documentRoot: FakeElement["ownerDocument"] & {
    hidden: boolean;
    defaultView: { MutationObserver: typeof Observer };
    addEventListener: (event: string, callback: () => void) => void;
    removeEventListener: (event: string) => void;
  } = {
    hidden: false,
    activeElement: null,
    body: null as unknown as HomeElement,
    documentElement: null as unknown as HomeElement,
    createElement: (tag) => new HomeElement(tag, documentRoot),
    defaultView: { MutationObserver: Observer },
    addEventListener: (event, callback) => { listeners.set(event, callback); },
    removeEventListener: (event) => { listeners.delete(event); },
  };
  documentRoot.documentElement = documentRoot.createElement("html");
  documentRoot.body = documentRoot.createElement("body");
  documentRoot.documentElement.append(documentRoot.body);
  const homeWorkspacePanel = documentRoot.createElement("main") as HomeElement;
  const homeDashboardRoot = documentRoot.createElement("div") as HomeElement;
  const homeWorkspaceButton = documentRoot.createElement("button") as HomeElement;
  const environmentSelect = documentRoot.createElement("select") as HomeElement;
  documentRoot.body.append(homeWorkspacePanel);
  homeWorkspacePanel.append(homeDashboardRoot);
  function setHomeVisible(visible: boolean) {
    homeWorkspacePanel.hidden = !visible;
    if (visible) homeWorkspacePanel.attributes.delete("hidden");
    else homeWorkspacePanel.setAttribute("hidden", "");
    observers.forEach((observer) => observer.callback());
  }
  setHomeVisible(!hidden);
  homeWorkspaceButton.click.mockImplementation(() => { setHomeVisible(true); });
  const runtimeClient = {
    getSystemHostConnection: vi.fn(async () => snapshot),
    supportsSystemHostConnection: vi.fn(() => supported),
    createSystemHostPairing: vi.fn(async () => ({ code: "p".repeat(43), expiresAt: "2099-01-01T00:00:00Z" })),
    connectLocalSystemHost: vi.fn(async () => ({ ok: true })),
    requestSystemHostPermissions: vi.fn(async (input: Record<string, unknown>) => ({
      ...input, ok: true, scope: "companion", executablePath: "/fixture/host-companion/runtime/node",
      permissions: { screenRecording: "required", accessibility: "granted" }, restartMayBeRequired: false,
    })),
    downloadSystemHostSetup: vi.fn(),
    revokeSystemHostConnection: vi.fn(async () => setupNeeded),
  };
  const onChange = vi.fn();
  const feature = createComputerAccessFeature({
    dom: { homeDashboardRoot, homeWorkspacePanel, homeWorkspaceButton, environmentSelect },
    runtimeClient,
    getEnvironmentId: () => environment,
    isComputerAccessAvailable: () => workspaceAccess.isAvailable("config"),
    onChange,
  });
  function setRuntimeAvailability(availability: { status: string; recovery?: string }) {
    workspaceAccess.update(availability);
    feature.runtimeAvailabilityChanged();
  }
  disposers.push(feature.dispose);
  const card = homeWorkspacePanel.querySelector(".home-computer-access") as HomeElement;
  return { feature, card, homeWorkspacePanel, homeDashboardRoot, homeWorkspaceButton, documentRoot, runtimeClient, onChange, setHomeVisible, observers, listeners,
    setEnvironment(value: string) { environment = value; environmentSelect.dispatch("change"); },
    setRuntimeAvailability,
    setRuntimeReady(value: boolean) { setRuntimeAvailability({ status: value ? "ready" : "setup_required" }); } };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

test("mounts the computer card before Home content and keeps it stable when guidance prepends", async () => {
  const h = homeHarness();
  await settle();
  expect(h.homeWorkspacePanel.children).toEqual([h.card, h.homeDashboardRoot]);
  expect(h.card.parentElement).toBe(h.homeWorkspacePanel);

  const guidance = h.documentRoot.createElement("section");
  guidance.className = "home-guidance";
  h.homeDashboardRoot.prepend(guidance);

  expect(h.homeWorkspacePanel.children).toEqual([h.card, h.homeDashboardRoot]);
  expect(h.homeDashboardRoot.contains(h.card)).toBe(false);
  expect(h.homeWorkspacePanel.querySelectorAll(".system-host-panel")).toHaveLength(1);
  expect(h.runtimeClient.getSystemHostConnection).toHaveBeenCalledExactlyOnceWith();
  expect(h.feature.state.snapshot).toBe(ready);
});

test("ready status and unpairing use the existing shared connection API", async () => {
  const h = homeHarness();
  await settle();
  expect(h.card.querySelector(".system-host-card-status")?.dataset.tone).toBe("ready");

  h.card.querySelector("[data-system-host-revoke]")!.dispatch("click");
  await settle();

  expect(h.runtimeClient.revokeSystemHostConnection).toHaveBeenCalledExactlyOnceWith();
  expect(h.feature.state.snapshot.paired).toBe(false);
  expect(h.card.querySelector("[data-system-host-revoke]")).toBeNull();
  expect(h.onChange).toHaveBeenCalled();
});

test("Home hides connected permissions until management is opened explicitly", async () => {
  const h = homeHarness();
  await settle();
  expect(h.card.querySelector("[data-system-host-management]")).toBeNull();
  h.feature.open();
  await settle();
  const disclosure = h.card.querySelector("[data-system-host-management]")!;
  expect(disclosure.attributes.has("open")).toBe(true);
  expect(disclosure.querySelector(".system-host-summary-permissions")).not.toBeNull();
  expect(disclosure.querySelector("summary")?.textContent).not.toContain("Unpairing disconnects");

  disclosure.open = true;
  disclosure.dispatch("toggle");
  await h.feature.load();
  expect(h.card.querySelector("[data-system-host-management]")?.attributes.has("open")).toBe(true);

  const refreshed = h.card.querySelector("[data-system-host-management]")!;
  refreshed.open = false;
  refreshed.dispatch("toggle");
  await h.feature.load();
  expect(h.card.querySelector("[data-system-host-management]")).toBeNull();
});

test("manual Mac pairing uses the existing pairing API from the Home card", async () => {
  const h = homeHarness({ snapshot: setupNeeded });
  await settle();

  h.card.querySelector('[data-system-host-mac="manual"]')!.dispatch("click");
  await settle();

  expect(h.runtimeClient.createSystemHostPairing).toHaveBeenCalledExactlyOnceWith();
  expect(h.runtimeClient.connectLocalSystemHost).not.toHaveBeenCalled();
  expect(h.runtimeClient.downloadSystemHostSetup).not.toHaveBeenCalled();
  expect(h.feature.state.manualMac.code).toBe("p".repeat(43));
});

test("local Mac connection refreshes readiness using the same manager", async () => {
  const h = homeHarness({
    snapshot: { ...setupNeeded, readiness: { ...setupNeeded.readiness, localSetupAvailable: true } },
  });
  await settle();
  h.runtimeClient.getSystemHostConnection.mockResolvedValue(ready);

  h.card.querySelector('[data-system-host-mac="local"]')!.dispatch("click");
  await settle();

  expect(h.runtimeClient.connectLocalSystemHost).toHaveBeenCalledExactlyOnceWith();
  expect(h.runtimeClient.getSystemHostConnection).toHaveBeenCalledTimes(2);
  expect(h.feature.state.snapshot).toBe(ready);
  expect(h.card.querySelector(".system-host-card-status")?.dataset.tone).toBe("ready");
});

test("bridge backend keeps a visible unavailable card without unsupported requests", async () => {
  const h = homeHarness({ supported: false });
  await settle();

  expect(h.card.parentElement).toBe(h.homeWorkspacePanel);
  expect(h.card.hidden).toBe(false);
  expect(h.card.querySelector(".system-host-card-status")?.dataset.tone).toBe("unavailable");
  expect(h.card.querySelector("[data-system-host-refresh]")?.disabled).toBe(true);
  expect(h.runtimeClient.getSystemHostConnection).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(9000);
  expect(h.runtimeClient.getSystemHostConnection).not.toHaveBeenCalled();
});

test("Home exposes an explicit permission check before chat without checking on discovery", async () => {
  const snapshot = { ...ready, connectionId: "socket-home", capabilities: ["macos_permission_preflight_v1"] };
  const h = homeHarness({ snapshot });
  await settle();
  expect(h.runtimeClient.requestSystemHostPermissions).not.toHaveBeenCalled();
  h.feature.open();
  await settle();
  h.card.querySelector("[data-mac-permissions-check]")!.dispatch("click");
  await settle();
  expect(h.runtimeClient.requestSystemHostPermissions).toHaveBeenCalledExactlyOnceWith({
    hostId: "home-computer", connectionId: "socket-home", action: "check",
  });
  expect(h.card.querySelector('[data-mac-permission-request="screen_recording"]')).not.toBeNull();
  expect(h.card.querySelector('[data-mac-permission-request="accessibility"]')).toBeNull();
});

test("Home environment changes invalidate pending native permission checks even after switching back", async () => {
  const native = { available: true, scope: "native_runtime", environmentId: "prod", ownerId: "runtime-prod", computerName: "Runtime Mac", executablePath: "/usr/local/bin/node" };
  const snapshot = { ...ready, nativePermissions: native };
  const h = homeHarness({ snapshot });
  await settle();
  h.feature.open();
  await settle();
  let finish!: (value: any) => void;
  h.runtimeClient.requestSystemHostPermissions.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  h.card.querySelector("[data-native-mac-permissions-check]")!.dispatch("click");
  expect(h.runtimeClient.requestSystemHostPermissions).toHaveBeenCalledOnce();
  const devSnapshot = { ...snapshot, nativePermissions: { ...native, environmentId: "dev", ownerId: "runtime-dev" } };
  h.runtimeClient.getSystemHostConnection.mockResolvedValueOnce(devSnapshot);
  h.setEnvironment("dev");
  await settle();
  h.setEnvironment("prod");
  await settle();
  finish({ ok: true, scope: "native_runtime", environmentId: "prod", ownerId: "runtime-prod", executablePath: native.executablePath,
    permissions: { screenRecording: "granted", accessibility: "granted" }, restartMayBeRequired: false });
  await settle();
  expect(h.feature.state.nativeMacPermissions).toBeNull();
  expect(h.card.querySelector(".system-host-summary-permissions")?.textContent).toContain("SYSTEM · not checked");
  expect(h.runtimeClient.getSystemHostConnection).toHaveBeenCalledTimes(3);
});

test("a failed refresh keeps the card visible and reports unavailable status", async () => {
  const h = homeHarness();
  await settle();
  h.runtimeClient.getSystemHostConnection.mockRejectedValueOnce(new Error("offline"));

  await h.feature.load();

  expect(h.card.parentElement).toBe(h.homeWorkspacePanel);
  expect(h.card.querySelector(".system-host-card-status")?.dataset.tone).toBe("unavailable");
  expect(h.feature.state.statusUnavailable).toBe(true);
});

test("open navigates to Home before focusing and scrolling the computer card", async () => {
  const h = homeHarness({ hidden: true });
  h.feature.open();
  await settle();

  expect(h.homeWorkspaceButton.click).toHaveBeenCalledOnce();
  expect(h.homeWorkspacePanel.hidden).toBe(false);
  expect(h.card.querySelector("[data-system-host-management]")?.attributes.has("open")).toBe(true);
  expect(h.card.scrollIntoView).toHaveBeenCalledOnce();
  expect(h.documentRoot.activeElement).toBe(h.card);
});

test("refused Home navigation leaves focus and scrolling untouched", () => {
  const h = homeHarness({ hidden: true });
  h.homeWorkspaceButton.click.mockImplementation(() => {});
  h.feature.open();

  expect(h.homeWorkspaceButton.click).toHaveBeenCalledOnce();
  expect(h.card.scrollIntoView).not.toHaveBeenCalled();
  expect(h.card.focus).not.toHaveBeenCalled();
  expect(h.runtimeClient.getSystemHostConnection).not.toHaveBeenCalled();
});

test("initially hidden Home causes no automatic read or polling", async () => {
  const h = homeHarness({ hidden: true });
  await vi.advanceTimersByTimeAsync(12000);

  expect(h.runtimeClient.getSystemHostConnection).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(h.observers[0].observe).toHaveBeenCalledWith(h.homeWorkspacePanel, {
    attributes: true,
    attributeFilter: ["hidden"],
  });
});

test("explicit refresh remains usable while Home is hidden without starting a poll", async () => {
  const h = homeHarness({ hidden: true });

  await h.feature.load();
  await vi.advanceTimersByTimeAsync(9000);

  expect(h.runtimeClient.getSystemHostConnection).toHaveBeenCalledExactlyOnceWith();
  expect(vi.getTimerCount()).toBe(0);
});

test("hiding Home stops automatic polling and showing it refreshes once", async () => {
  const h = homeHarness();
  await settle();
  await vi.advanceTimersByTimeAsync(3000);
  expect(h.runtimeClient.getSystemHostConnection).toHaveBeenCalledTimes(2);

  h.setHomeVisible(false);
  await vi.advanceTimersByTimeAsync(12000);
  expect(h.runtimeClient.getSystemHostConnection).toHaveBeenCalledTimes(2);

  h.setHomeVisible(true);
  await settle();
  expect(h.runtimeClient.getSystemHostConnection).toHaveBeenCalledTimes(3);
});

test("disposing the Home feature removes visibility listeners and scheduled polling", async () => {
  const h = homeHarness();
  await settle();
  h.feature.dispose();
  await vi.advanceTimersByTimeAsync(12000);

  expect(h.runtimeClient.getSystemHostConnection).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(h.listeners.has("visibilitychange")).toBe(false);
  expect(h.observers[0].disconnect).toHaveBeenCalled();
});


test.each(["loading", "checking", "error", "setup_required"])("initial %s hides computer access and blocks polling, refresh and opening", async (status) => {
  const h = homeHarness({ runtimeReady: false });
  h.setRuntimeAvailability({ status });
  await settle();
  expect(h.card.hidden).toBe(true);
  expect(h.feature.state.active).toBe(false);
  expect(await h.feature.load()).toBe(false);
  expect(h.feature.open()).toBe(false);
  expect(h.homeWorkspaceButton.click).not.toHaveBeenCalled();
  h.setEnvironment("dev");
  await vi.advanceTimersByTimeAsync(9000);
  expect(h.runtimeClient.getSystemHostConnection).not.toHaveBeenCalled();
});

test("finishing onboarding shows Home computer access and returning to setup stops polling", async () => {
  const h = homeHarness({ runtimeReady: false });
  await settle();
  h.setRuntimeReady(true);
  await settle();
  expect(h.card.hidden).toBe(false);
  expect(h.feature.state.active).toBe(true);
  expect(h.runtimeClient.getSystemHostConnection).toHaveBeenCalledOnce();
  h.setRuntimeReady(true);
  await settle();
  expect(h.runtimeClient.getSystemHostConnection).toHaveBeenCalledOnce();

  h.setRuntimeReady(false);
  expect(h.card.hidden).toBe(true);
  await vi.advanceTimersByTimeAsync(9000);
  expect(h.runtimeClient.getSystemHostConnection).toHaveBeenCalledOnce();
  h.setRuntimeReady(true);
  await settle();
  expect(h.card.hidden).toBe(false);
  expect(h.runtimeClient.getSystemHostConnection).toHaveBeenCalledTimes(2);
});

test("a pending connection response cannot show the Home card after onboarding starts", async () => {
  const h = homeHarness();
  await settle();
  let finish!: (value: typeof ready) => void;
  h.runtimeClient.getSystemHostConnection.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.feature.load();
  h.setRuntimeReady(false);
  finish(ready);
  await pending;
  await vi.advanceTimersByTimeAsync(9000);
  expect(h.card.hidden).toBe(true);
  expect(h.feature.state.active).toBe(false);
  expect(h.runtimeClient.getSystemHostConnection).toHaveBeenCalledTimes(2);
});


test("configured catalog refresh and recovery preserve Home computer access and polling", async () => {
  const h = homeHarness();
  await settle();
  for (const availability of [
    { status: "checking" }, { status: "error" },
    { status: "setup_required", recovery: "configuration" },
  ]) {
    const reads = h.runtimeClient.getSystemHostConnection.mock.calls.length;
    h.setRuntimeAvailability(availability);
    await settle();
    expect(h.card.hidden).toBe(false);
    expect(h.feature.state.active).toBe(true);
    expect(h.runtimeClient.getSystemHostConnection).toHaveBeenCalledTimes(reads);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.runtimeClient.getSystemHostConnection).toHaveBeenCalledTimes(reads + 1);
    await h.feature.load();
    expect(h.runtimeClient.getSystemHostConnection).toHaveBeenCalledTimes(reads + 2);
    expect(h.feature.open()).toBe(true);
    expect(h.documentRoot.activeElement).toBe(h.card);
    expect(h.card.querySelector("[data-system-host-management]")?.attributes.has("open")).toBe(true);
  }
  expect(h.homeWorkspaceButton.click).toHaveBeenCalledTimes(3);
});
