import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createSystemHostConnectionManager } from "../../web-ui/app/components/system-host/manager.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

const snapshot = {
  paired: true, connected: true, hostId: "mac-a", connectionId: "socket-a",
  identity: { os: "macos" },
  capabilities: ["macos_permission_preflight_v1"],
  readiness: { ready: true, route: "companion" },
};
const receipt = {
  ok: true, hostId: "mac-a", connectionId: "socket-a", scope: "companion",
  permissions: { screenRecording: "required", accessibility: "required" },
  executablePath: "/fixture/host-companion/runtime/node", restartMayBeRequired: true,
};
const disposers: Array<() => void> = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(initial: unknown = snapshot) {
  let environment = "prod";
  const documentRoot = {
    hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    body: null as unknown as FakeElement, documentElement: null as unknown as FakeElement,
    activeElement: null, createElement: (tag: string) => new FakeElement(tag, documentRoot),
  };
  documentRoot.documentElement = documentRoot.createElement("html");
  documentRoot.body = documentRoot.createElement("body");
  const root = documentRoot.createElement("section");
  const dependencies = {
    documentRoot, compact: true,
    getEnvironmentId: () => environment,
    loadConnection: vi.fn(async (): Promise<unknown> => initial),
    requestPermissions: vi.fn(async (): Promise<unknown> => receipt),
    revokeConnection: vi.fn(async () => ({ paired: false, connected: false })),
    schedulePoll: vi.fn(), cancelPoll: vi.fn(),
  };
  const manager = createSystemHostConnectionManager(dependencies);
  manager.mount(root);
  disposers.push(manager.dispose);
  async function activate() {
    manager.setActive(true);
    await vi.waitFor(() => expect(manager.state.busy).toBe(false));
  }
  return { root, dependencies, manager, activate,
    setEnvironment(value: string) { environment = value; manager.environmentChanged(); } };
}

test("connection discovery and polling never check or request macOS permissions", async () => {
  const h = harness();
  await h.activate();
  await h.manager.load(true);
  expect(h.dependencies.requestPermissions).not.toHaveBeenCalled();
  expect(h.root.querySelector("[data-mac-permissions-check]")).not.toBeNull();
  expect(h.root.querySelectorAll("[data-mac-permission-request]")).toHaveLength(0);
  expect(h.root.innerHTML).not.toContain("Start collection in Spark");
  expect(h.root.querySelector(".system-host-summary-permissions")?.textContent).not.toContain("granted");
});

test("explicit check binds the current connection and requests only missing permissions", async () => {
  const h = harness();
  await h.activate();
  h.root.querySelector("[data-mac-permissions-check]")!.dispatch("click");
  await vi.waitFor(() => expect(h.manager.state.busy).toBe(false));
  expect(h.dependencies.requestPermissions).toHaveBeenCalledExactlyOnceWith({
    hostId: "mac-a", connectionId: "socket-a", action: "check",
  });
  expect(h.root.querySelector(".system-host-permission-path")?.textContent).toBe(receipt.executablePath);
  expect(h.root.querySelectorAll("[data-mac-permission-request]")).toHaveLength(2);
  h.dependencies.requestPermissions.mockResolvedValueOnce({
    ...receipt, permissions: { screenRecording: "granted", accessibility: "required" },
  });
  h.root.querySelector('[data-mac-permission-request="screen_recording"]')!.dispatch("click");
  await vi.waitFor(() => expect(h.manager.state.busy).toBe(false));
  expect(h.dependencies.requestPermissions).toHaveBeenLastCalledWith({
    hostId: "mac-a", connectionId: "socket-a", action: "request", permission: "screen_recording",
  });
  expect(h.root.querySelector('[data-mac-permission-request="screen_recording"]')).toBeNull();
  expect(h.root.querySelector('[data-mac-permission-request="accessibility"]')).not.toBeNull();
  expect(await h.manager.requestPermission("screen_recording")).toBe(false);
  expect(await h.manager.requestPermission("other_permission")).toBe(false);
  expect(h.root.querySelectorAll('[data-granted="true"]')).toHaveLength(1);
});

test("checking granted companion access leaves unavailable native SYSTEM access separate", async () => {
  const h = harness();
  await h.activate();
  h.dependencies.requestPermissions.mockResolvedValueOnce({
    ...receipt, permissions: { screenRecording: "granted", accessibility: "granted" },
  });
  await h.manager.checkPermissions();
  expect(h.root.querySelectorAll('[data-granted="true"]')).toHaveLength(2);
  expect(h.root.querySelectorAll("[data-mac-permission-request]")).toHaveLength(0);
  const native = h.root.querySelector('[data-permission-route="native-mac"]')!;
  expect(native.querySelectorAll("button")).toHaveLength(0);
  expect(h.root.querySelector(".system-host-summary-permissions")?.textContent).toContain("SYSTEM · unavailable");
});

const nativeMetadata = {
  available: true, scope: "native_runtime", environmentId: "prod", ownerId: "runtime-a",
  computerName: "Runtime Mac", executablePath: "/opt/homebrew/bin/node",
};
const nativeReceipt = {
  ok: true, scope: "native_runtime", environmentId: "prod", ownerId: "runtime-a",
  permissions: { screenRecording: "granted", accessibility: "required" },
  executablePath: "/opt/homebrew/bin/node", restartMayBeRequired: false,
};

test("native SYSTEM can be prepared before companion pairing with the current Runtime binding", async () => {
  const h = harness({ paired: false, connected: false, nativePermissions: nativeMetadata });
  await h.activate();
  expect(h.dependencies.requestPermissions).not.toHaveBeenCalled();
  expect(h.root.querySelector('[data-permission-route="mac"]')).toBeNull();
  expect(h.root.querySelector('[data-permission-route="native-mac"]')?.textContent).toContain("Runtime Mac");
  h.dependencies.requestPermissions.mockResolvedValueOnce(nativeReceipt);
  h.root.querySelector("[data-native-mac-permissions-check]")!.dispatch("click");
  await vi.waitFor(() => expect(h.manager.state.busy).toBe(false));
  expect(h.dependencies.requestPermissions).toHaveBeenCalledExactlyOnceWith({
    scope: "native_runtime", environmentId: "prod", ownerId: "runtime-a", action: "check",
  });
  expect(h.root.querySelector('[data-native-mac-permission-request="screen_recording"]')).toBeNull();
  expect(h.root.querySelector('[data-native-mac-permission-request="accessibility"]')).not.toBeNull();
  h.dependencies.requestPermissions.mockResolvedValueOnce(nativeReceipt);
  expect(await h.manager.requestNativePermission("accessibility")).toBe(true);
  expect(h.dependencies.requestPermissions).toHaveBeenLastCalledWith({
    scope: "native_runtime", environmentId: "prod", ownerId: "runtime-a", action: "request", permission: "accessibility",
  });
});

test("native errors and checks cannot reuse or erase companion grants", async () => {
  const h = harness({ ...snapshot, nativePermissions: nativeMetadata });
  await h.activate();
  h.dependencies.requestPermissions.mockResolvedValueOnce({ ...receipt, permissions: { screenRecording: "granted", accessibility: "granted" } });
  await h.manager.checkPermissions();
  expect(h.root.querySelector(".system-host-summary-permissions")?.textContent).toBe("SYSTEM · not checked · Companion · granted");
  expect(await h.manager.requestNativePermission("accessibility")).toBe(false);
  h.dependencies.requestPermissions.mockRejectedValueOnce(new Error("unavailable"));
  await h.manager.checkNativePermissions();
  expect(h.manager.state.macPermissions).not.toBeNull();
  expect(h.manager.state.nativeMacPermissions).toBeNull();
  expect(h.root.querySelector('[data-permission-route="native-mac"]')?.querySelector('[role="alert"]')).not.toBeNull();
  expect(h.root.querySelector('[data-permission-route="mac"]')?.querySelector('[role="alert"]')).toBeNull();
  h.dependencies.requestPermissions.mockResolvedValueOnce(nativeReceipt);
  await h.manager.checkNativePermissions();
  expect(h.root.querySelector(".system-host-summary-permissions")?.textContent).toBe("SYSTEM · action needed · Companion · granted");
});

test.each([
  { ...nativeReceipt, ownerId: "old-owner" },
  { ...nativeReceipt, environmentId: "dev" },
  { ...nativeReceipt, scope: "companion" },
])("native receipts reject wrong owner, environment or route (%#)", async wrong => {
  const h = harness({ ...snapshot, nativePermissions: nativeMetadata });
  await h.activate();
  h.dependencies.requestPermissions.mockResolvedValueOnce(wrong);
  expect(await h.manager.checkNativePermissions()).toBe(false);
  expect(h.manager.state.nativeMacPermissions).toBeNull();
});

test("environment switch away and back rejects the earlier native response", async () => {
  const initial = { ...snapshot, nativePermissions: nativeMetadata };
  const h = harness(initial);
  await h.activate();
  const pending = deferred<unknown>();
  h.dependencies.requestPermissions.mockImplementationOnce(() => pending.promise);
  const checking = h.manager.checkNativePermissions();
  h.dependencies.loadConnection.mockResolvedValueOnce({ ...snapshot, nativePermissions: { ...nativeMetadata, environmentId: "dev" } });
  h.setEnvironment("dev");
  await vi.waitFor(() => expect(h.manager.state.busy).toBe(false));
  h.setEnvironment("prod");
  await vi.waitFor(() => expect(h.manager.state.busy).toBe(false));
  pending.resolve(nativeReceipt);
  expect(await checking).toBe(false);
  expect(h.manager.state.nativeMacPermissions).toBeNull();
  expect(h.manager.state.snapshot).toEqual(initial);
});

test("native Runtime replacement clears its receipt while companion receipt remains bound", async () => {
  const h = harness({ ...snapshot, nativePermissions: nativeMetadata });
  await h.activate();
  await h.manager.checkPermissions();
  h.dependencies.requestPermissions.mockResolvedValueOnce(nativeReceipt);
  await h.manager.checkNativePermissions();
  h.dependencies.loadConnection.mockResolvedValueOnce({ ...snapshot, nativePermissions: { ...nativeMetadata, ownerId: "new-runtime" } });
  await h.manager.load(true);
  expect(h.manager.state.nativeMacPermissions).toBeNull();
  expect(h.manager.state.macPermissions).toEqual(receipt);
});

test.each(["native_macos_unavailable", "local_browser_required", "runtime_not_started", "runtime_owner_unavailable"])("unavailable native route %s never offers permission actions", async reason => {
  const h = harness({ ...snapshot, nativePermissions: { available: false, scope: "native_runtime", environmentId: "prod", reason } });
  await h.activate();
  expect(h.root.querySelector('[data-permission-route="native-mac"]')).not.toBeNull();
  expect(h.root.querySelector("[data-native-mac-permissions-check]")).toBeNull();
  expect(await h.manager.checkNativePermissions()).toBe(false);
  expect(h.dependencies.requestPermissions).not.toHaveBeenCalled();
});

test("non-Mac Runtime without a Mac companion has no macOS preparation controls", async () => {
  const h = harness({ paired: false, connected: false, nativePermissions: { available: false, environmentId: "prod", reason: "native_macos_unavailable" } });
  await h.activate();
  expect(h.root.querySelector("[data-system-host-mac-permissions]")).toBeNull();
});

test("a pending permission request cannot be duplicated and controls stay disabled", async () => {
  const h = harness();
  await h.activate();
  const pending = deferred<unknown>();
  h.dependencies.requestPermissions.mockImplementationOnce(() => pending.promise);
  const checking = h.manager.checkPermissions();
  expect(h.root.querySelector("[data-mac-permissions-check]")?.disabled).toBe(true);
  expect(await h.manager.checkPermissions()).toBe(false);
  expect(await h.manager.requestPermission("screen_recording")).toBe(false);
  pending.resolve(receipt);
  expect(await checking).toBe(true);
  expect(h.dependencies.requestPermissions).toHaveBeenCalledOnce();
});

test.each(["hide", "reset", "dispose"])("late permission receipt after %s cannot restore a grant", async action => {
  const h = harness();
  await h.activate();
  const pending = deferred<unknown>();
  h.dependencies.requestPermissions.mockImplementationOnce(() => pending.promise);
  const checking = h.manager.checkPermissions();
  if (action === "hide") h.manager.setActive(false);
  if (action === "reset") h.manager.reset();
  if (action === "dispose") h.manager.dispose();
  pending.resolve(receipt);
  expect(await checking).toBe(false);
  expect(h.manager.state.macPermissions).toBeNull();
});

test("hiding and returning invalidates an old check even when the host is unchanged", async () => {
  const h = harness();
  await h.activate();
  const pending = deferred<unknown>();
  h.dependencies.requestPermissions.mockImplementationOnce(() => pending.promise);
  const checking = h.manager.checkPermissions();
  h.manager.setActive(false);
  h.manager.setActive(true);
  pending.resolve(receipt);
  expect(await checking).toBe(false);
  expect(h.manager.state.macPermissions).toBeNull();
});

test.each([
  { ...receipt, connectionId: "old-socket" },
  { ...receipt, hostId: "other-mac" },
  { ...receipt, scope: "calling_application" },
  { ...receipt, permissions: { screenRecording: "unknown", accessibility: "granted" } },
  { ...receipt, executablePath: "node" },
])("malformed or misbound permission receipt is never rendered as granted (%#)", async invalid => {
  const h = harness();
  await h.activate();
  h.dependencies.requestPermissions.mockResolvedValueOnce(invalid);
  expect(await h.manager.checkPermissions()).toBe(false);
  expect(h.manager.state.macPermissions).toBeNull();
  expect(h.root.querySelector('[role="alert"]')).not.toBeNull();
});

test("connection replacement, disconnect and unpair clear checked permission state", async () => {
  const h = harness();
  await h.activate();
  await h.manager.checkPermissions();
  h.dependencies.loadConnection.mockResolvedValueOnce({ ...snapshot, connectionId: "socket-b" });
  await h.manager.load(true);
  expect(h.manager.state.macPermissions).toBeNull();
  h.dependencies.loadConnection.mockResolvedValueOnce(snapshot);
  await h.manager.load(true);
  await h.manager.checkPermissions();
  h.dependencies.loadConnection.mockResolvedValueOnce({ ...snapshot, connected: false });
  await h.manager.load(true);
  expect(h.manager.state.macPermissions).toBeNull();
  h.dependencies.loadConnection.mockResolvedValueOnce(snapshot);
  await h.manager.load(true);
  await h.manager.checkPermissions();
  await h.manager.revoke();
  expect(h.manager.state.macPermissions).toBeNull();
});

test.each([
  { ...snapshot, connected: false },
  { ...snapshot, capabilities: [] },
  { ...snapshot, readiness: { ...snapshot.readiness, companionUpdateRequired: true } },
  { ...snapshot, identity: { os: "windows" } },
  { ...snapshot, identity: { os: "linux" } },
])("unsupported or offline connection cannot request permissions (%#)", async unavailable => {
  const h = harness(unavailable);
  await h.activate();
  expect(h.root.querySelector("[data-mac-permissions-check]")).toBeNull();
  expect(await h.manager.checkPermissions()).toBe(false);
  expect(await h.manager.requestPermission("accessibility")).toBe(false);
  expect(h.dependencies.requestPermissions).not.toHaveBeenCalled();
});

test("failed recheck discards old grants and escapes host executable output", async () => {
  const h = harness();
  await h.activate();
  h.dependencies.requestPermissions.mockResolvedValueOnce({ ...receipt, executablePath: "/fixture/<script>/node" });
  await h.manager.checkPermissions();
  expect(h.root.innerHTML).not.toContain("<script>");
  expect(h.root.querySelector("script")).toBeNull();
  expect(h.root.querySelector(".system-host-permission-path")?.textContent).toBe("/fixture/<script>/node");
  h.dependencies.requestPermissions.mockRejectedValueOnce(new Error("unavailable"));
  expect(await h.manager.checkPermissions()).toBe(false);
  expect(h.manager.state.macPermissions).toBeNull();
  expect(h.root.querySelector('[role="alert"]')).not.toBeNull();
});
