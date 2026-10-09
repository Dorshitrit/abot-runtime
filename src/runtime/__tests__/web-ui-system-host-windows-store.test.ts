import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createSystemHostConnectionManager } from "../../web-ui/app/components/system-host/manager.js";
// @ts-expect-error Browser-only module.
import { windowsStoreSetupIsAvailable } from "../../web-ui/app/components/system-host/windows-store-setup.js";

const setup = {
  paired: false, connected: false,
  readiness: { ready: false, route: "setup_required", platforms: ["windows"], restartRequired: false },
};
const ready = {
  paired: true, connected: true,
  identity: { name: "Windows computer", os: "windows", user: "owner" },
  readiness: { ready: true, route: "companion", platforms: [], restartRequired: false },
};
const launchUrl = "abot-companion://connect?invitation=private_pairing_invitation";
const storeUrl = "https://apps.microsoft.com/detail/9PK2FDQQLQS9";
const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
});

function harness(snapshot: unknown = setup) {
  const clicks = new Map<string, () => void>();
  const visibilityListeners = new Map<string, () => void>();
  const root = {
    innerHTML: "",
    querySelector: (selector: string) => ({
      addEventListener: (_: string, listener: () => void) => clicks.set(selector, listener),
    }),
    querySelectorAll: () => [],
  };
  const dependencies = {
    loadConnection: vi.fn(async (): Promise<unknown> => snapshot),
    requestStoreConnection: vi.fn(async (): Promise<unknown> => ({
      ok: true, launchUrl, storeUrl, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
    downloadSetup: vi.fn(), saveDownload: vi.fn(),
    revokeConnection: vi.fn(async () => setup),
    schedulePoll: vi.fn(), cancelPoll: vi.fn(),
    documentRoot: {
      hidden: false,
      addEventListener: (name: string, callback: () => void) => visibilityListeners.set(name, callback),
      removeEventListener: (name: string) => visibilityListeners.delete(name),
    },
  };
  const manager = createSystemHostConnectionManager(dependencies);
  manager.mount(root);
  disposers.push(manager.dispose);
  return {
    manager, dependencies, root, clicks, visibilityListeners,
    async activate() {
      manager.setActive(true);
      await vi.waitFor(() => expect(manager.state.busy).toBe(false));
    },
  };
}

describe("Windows Store connection", () => {
  test("offers installation and explicit protocol launch without a setup download or assumed readiness", async () => {
    const h = harness();
    await h.activate();
    expect(h.root.innerHTML).toContain(storeUrl);
    expect(h.root.innerHTML).toContain('data-system-host-store-stage="start"');
    expect(h.root.innerHTML.match(/class="system-host-card-primary"/g)).toHaveLength(1);
    expect(h.root.innerHTML).not.toContain('data-system-host-install="windows"');
    expect(h.dependencies.requestStoreConnection).not.toHaveBeenCalled();
    h.clicks.get("[data-system-host-store-connect]")!();
    await vi.waitFor(() => expect(h.manager.state.busy).toBe(false));
    expect(h.dependencies.requestStoreConnection).toHaveBeenCalledOnce();
    expect(h.dependencies.downloadSetup).not.toHaveBeenCalled();
    expect(h.dependencies.saveDownload).not.toHaveBeenCalled();
    expect(h.root.innerHTML).toContain(`href="${launchUrl}"`);
    expect(h.root.innerHTML).toContain('data-system-host-store-stage="open"');
    expect(h.root.innerHTML).not.toContain("data-system-host-store-connect");
    expect(h.root.innerHTML).not.toContain(storeUrl);
    expect(h.root.innerHTML.match(/class="system-host-card-primary"/g)).toHaveLength(1);
    expect(await h.manager.connectWindowsStore()).toBe(false);
    expect(h.dependencies.requestStoreConnection).toHaveBeenCalledOnce();
    expect(h.manager.state.snapshot.readiness.ready).toBe(false);
    h.dependencies.loadConnection.mockResolvedValueOnce(ready);
    await h.manager.load(true);
    expect(h.manager.state.windowsStoreInvitation).toBeNull();
    expect(h.root.innerHTML).not.toContain(launchUrl);
    expect(h.root.innerHTML).toContain('data-system-host-store-stage="ready"');
    expect(h.root.innerHTML).not.toContain("data-system-host-store-launch");
  });

  test("opening transitions to approval instructions without claiming a connection or creating another grant", async () => {
    const h = harness();
    await h.activate();
    await h.manager.connectWindowsStore();
    h.clicks.get("[data-system-host-store-launch]")!();
    await vi.waitFor(() => expect(h.root.innerHTML).toContain('data-system-host-store-stage="waiting"'));
    expect(h.manager.state.windowsStoreAttempt.phase).toBe("waiting");
    expect(h.manager.state.snapshot.readiness.ready).toBe(false);
    expect(h.root.innerHTML).toContain(`href="${launchUrl}"`);
    expect(h.root.innerHTML).toContain('class="system-host-card-secondary"');
    expect(h.root.innerHTML).not.toContain('class="system-host-card-primary"');
    expect(h.root.innerHTML).not.toContain("data-system-host-store-connect");
    expect(h.dependencies.requestStoreConnection).toHaveBeenCalledOnce();
    h.dependencies.loadConnection.mockResolvedValueOnce(ready);
    await h.manager.load(true);
    expect(h.manager.state.windowsStoreAttempt).toBeNull();
    expect(h.root.innerHTML).toContain('data-system-host-store-stage="ready"');
    expect(h.root.innerHTML).not.toContain("data-system-host-store-connect");
    expect(h.root.innerHTML).not.toContain("data-system-host-store-launch");
  });

  test("returning from Companion preserves only waiting intent and expiry while the URI stays cleared", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.activate();
    await h.manager.connectWindowsStore();
    h.clicks.get("[data-system-host-store-launch]")!();
    const expiresAt = h.manager.state.windowsStoreInvitation.expiresAt;
    h.dependencies.documentRoot.hidden = true;
    h.visibilityListeners.get("visibilitychange")!();
    expect(h.manager.state.windowsStoreInvitation).toBeNull();
    expect(h.manager.state.windowsStoreAttempt).toEqual({ phase: "waiting", expiresAt });
    h.dependencies.documentRoot.hidden = false;
    h.visibilityListeners.get("visibilitychange")!();
    await vi.waitFor(() => expect(h.manager.state.busy).toBe(false));
    expect(h.root.innerHTML).toContain('data-system-host-store-stage="waiting"');
    expect(h.root.innerHTML).not.toContain(launchUrl);
    expect(h.root.innerHTML).not.toContain('class="system-host-card-primary"');
    expect(h.root.innerHTML).toContain("data-system-host-store-connect");
    expect(h.dependencies.requestStoreConnection).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_001);
    await h.manager.load(true);
    expect(h.root.innerHTML).toContain('data-system-host-store-stage="expired"');
    expect(h.root.innerHTML.match(/class="system-host-card-primary"/g)).toHaveLength(1);
  });

  test("a paired offline companion opens its saved connection without creating an upgrade invitation", async () => {
    const h = harness({
      ...setup, paired: true,
      readiness: { ...setup.readiness, route: "companion", companionUpdateRequired: true },
    });
    await h.activate();
    expect(h.root.innerHTML).toContain('href="abot-companion://open"');
    expect(h.root.innerHTML).not.toContain(storeUrl);
    expect(await h.manager.install("windows")).toBe(false);
    expect(h.dependencies.requestStoreConnection).not.toHaveBeenCalled();
    expect(h.dependencies.downloadSetup).not.toHaveBeenCalled();
  });

  test.each([
    { ...setup.readiness, restartRequired: true },
    { ...setup.readiness, route: "wsl_interop" },
    { ...setup.readiness, route: "native" },
  ])("does not download Windows setup when Store setup is unavailable (%j)", async (readiness) => {
    const h = harness({ ...setup, readiness: { ...readiness, message: "Download the legacy Windows setup." } });
    await h.activate();
    expect(await h.manager.install("windows")).toBe(false);
    expect(h.dependencies.requestStoreConnection).not.toHaveBeenCalled();
    expect(h.dependencies.downloadSetup).not.toHaveBeenCalled();
    expect(h.dependencies.saveDownload).not.toHaveBeenCalled();
    expect(h.root.innerHTML).not.toContain('data-system-host-install="windows"');
    expect(h.root.innerHTML).not.toContain("Download the legacy Windows setup");
    expect(h.root.innerHTML).not.toContain("Download setup");
    expect(h.root.innerHTML).not.toContain("system-host-restart");
  });

  test("routes a connected Windows companion requiring an update through Store", async () => {
    const h = harness({
      ...ready,
      readiness: { ...setup.readiness, route: "companion", companionUpdateRequired: true },
    });
    await h.activate();
    expect(h.root.innerHTML).toContain(`href="${storeUrl}"`);
    expect(h.root.innerHTML).toContain("Update in Microsoft Store");
    expect(h.root.innerHTML).not.toContain('data-system-host-install="windows"');
    expect(await h.manager.install("windows")).toBe(true);
    expect(h.dependencies.requestStoreConnection).toHaveBeenCalledOnce();
    expect(h.dependencies.downloadSetup).not.toHaveBeenCalled();
    expect(h.dependencies.saveDownload).not.toHaveBeenCalled();
    expect(h.root.innerHTML).toContain(`href="${launchUrl}"`);
    expect(h.manager.state.snapshot.readiness.ready).toBe(false);
  });

  test("removes expired invitations from state and the launch anchor", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.activate();
    await h.manager.connectWindowsStore();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(h.manager.state.windowsStoreInvitation).toBeNull();
    expect(h.root.innerHTML).not.toContain(launchUrl);
    expect(h.root.innerHTML).toContain("link expired");
  });

  test.each(["hide", "reset", "environment", "revoke", "status-error"])(
    "clears the invitation on %s",
    async (action) => {
      const h = harness();
      await h.activate();
      await h.manager.connectWindowsStore();
      if (action === "hide") h.manager.setActive(false);
      if (action === "reset") h.manager.reset();
      if (action === "environment") h.manager.environmentChanged();
      if (action === "revoke") await h.manager.revoke();
      if (action === "status-error") {
        h.dependencies.loadConnection.mockRejectedValueOnce(new Error("private backend detail"));
        await h.manager.load(true);
      }
      expect(h.manager.state.windowsStoreInvitation).toBeNull();
      expect(h.root.innerHTML).not.toContain(launchUrl);
    },
  );

  test("discards a response after leaving the connection surface", async () => {
    let resolve!: (value: unknown) => void;
    const h = harness();
    await h.activate();
    h.dependencies.requestStoreConnection.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = h.manager.connectWindowsStore();
    expect(h.manager.state.windowsStoreAttempt.phase).toBe("preparing");
    expect(h.root.innerHTML).toContain('data-system-host-store-stage="preparing"');
    expect(await h.manager.connectWindowsStore()).toBe(false);
    expect(h.dependencies.requestStoreConnection).toHaveBeenCalledOnce();
    h.manager.setActive(false);
    resolve({ launchUrl, storeUrl, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await pending).toBe(false);
    expect(h.manager.state.windowsStoreInvitation).toBeNull();
  });

  test("does not expose request errors or accept another launch scheme", async () => {
    const h = harness();
    await h.activate();
    h.dependencies.requestStoreConnection.mockRejectedValueOnce(new Error(launchUrl));
    expect(await h.manager.connectWindowsStore()).toBe(false);
    expect(h.root.innerHTML).not.toContain(launchUrl);
    h.dependencies.requestStoreConnection.mockResolvedValueOnce({
      launchUrl: "javascript:alert(1)", storeUrl, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await h.manager.connectWindowsStore()).toBe(false);
    expect(h.root.innerHTML).not.toContain("javascript:");
  });

  test.each([
    { ...setup.readiness, platforms: ["linux", "macos"] },
    { ...setup.readiness, restartRequired: true },
    { ...setup.readiness, route: "wsl_interop" },
    { ...setup.readiness, route: "native" },
    { ...setup.readiness, ready: true },
  ])("preserves other platform and direct-access setup routes (%j)", (readiness) => {
    expect(windowsStoreSetupIsAvailable({ readiness })).toBe(false);
  });
});
