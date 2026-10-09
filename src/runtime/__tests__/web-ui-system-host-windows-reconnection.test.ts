import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createSystemHostConnectionManager } from "../../web-ui/app/components/system-host/manager.js";

const paired = {
  ok: true, paired: true, connected: false, hostId: "paired-host",
  identity: { os: "windows", name: "Owner's Windows computer" },
  readiness: { ready: false, route: "companion", platforms: ["windows"], restartRequired: false, companionUpdateRequired: true },
};
const unpaired = {
  ok: true, paired: false, connected: false,
  readiness: { ready: false, route: "setup_required", platforms: ["windows"], restartRequired: false },
};
function receipt() {
  return {
    ok: true, launchUrl: "abot-companion://connect?invitation=fresh_pairing",
    storeUrl: "https://apps.microsoft.com/detail/9PK2FDQQLQS9",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => { resolve = done; });
  return { resolve, promise };
}
const disposers: Array<() => void> = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));

function harness() {
  let environment = "dev";
  const root = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
  const dependencies = {
    compact: true,
    loadConnection: vi.fn(async (): Promise<unknown> => paired),
    requestStoreConnection: vi.fn(async (): Promise<unknown> => receipt()),
    revokeConnection: vi.fn(async (): Promise<unknown> => unpaired),
    downloadSetup: vi.fn(), saveDownload: vi.fn(),
    getEnvironmentId: () => environment,
    schedulePoll: vi.fn(), cancelPoll: vi.fn(),
    documentRoot: { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() },
  };
  const manager = createSystemHostConnectionManager(dependencies);
  manager.mount(root);
  disposers.push(manager.dispose);
  return {
    root, manager, dependencies,
    changeEnvironment: () => { environment = "prod"; },
    async activate() {
      manager.setActive(true);
      await vi.waitFor(() => expect(manager.state.busy).toBe(false));
    },
  };
}

describe("Windows saved connection and explicit re-pairing", () => {
  test("ordinary reconnect opens the app without grants and keeps removal available in the same card", async () => {
    const h = harness();
    await h.activate();
    expect(h.root.innerHTML).toContain('href="abot-companion://open"');
    expect(h.root.innerHTML).toContain('data-system-host-store-stage="reconnect"');
    expect(h.root.innerHTML.match(/class="system-host-card-primary"/g)).toHaveLength(1);
    expect(h.root.innerHTML).not.toContain("data-system-host-store-connect");
    expect(h.root.innerHTML.match(/data-system-host-revoke/g)).toHaveLength(1);
    expect(h.root.innerHTML).not.toContain("system-host-management-body");
    expect(h.root.innerHTML).not.toContain("system-host-identity");
    expect(await h.manager.install("windows")).toBe(false);
    expect(h.dependencies.requestStoreConnection).not.toHaveBeenCalled();
    expect(h.dependencies.revokeConnection).not.toHaveBeenCalled();
  });

  test("verified Windows readiness keeps one compact heading and metadata without another connection action", async () => {
    const h = harness();
    await h.activate();
    h.dependencies.loadConnection.mockResolvedValueOnce({
      ...paired,
      connected: true,
      identity: { os: "windows", name: "<office>", user: "owner" },
      readiness: { ...paired.readiness, ready: true, platforms: [], companionUpdateRequired: false },
    });
    await h.manager.load(true);
    expect(h.root.innerHTML.match(/<h2\b/g)).toHaveLength(1);
    expect(h.root.innerHTML).toContain("system-host-card-ready");
    expect(h.root.innerHTML).not.toContain("system-host-card-description");
    expect(h.root.innerHTML).not.toContain("data-system-host-management");
    expect(h.root.innerHTML).not.toContain("system-host-identity");
    expect(h.root.innerHTML).toContain("&lt;office&gt;");
    expect(h.root.innerHTML).not.toContain("<office>");
    expect(h.root.innerHTML).toContain("owner");
    expect(h.root.innerHTML).not.toContain("paired-host");
    expect(h.root.innerHTML).not.toContain("data-system-host-store-connect");
    expect(h.root.innerHTML).not.toContain("data-system-host-store-launch");
    expect(h.root.innerHTML).not.toContain("data-system-host-store-open-existing");
    expect(h.root.innerHTML.match(/data-system-host-revoke/g)).toHaveLength(1);
    expect(h.dependencies.requestStoreConnection).not.toHaveBeenCalled();
    expect(h.dependencies.revokeConnection).not.toHaveBeenCalled();
  });

  test("confirmation and cancel do not mutate pairing or create a grant", async () => {
    const h = harness();
    await h.activate();
    expect(await h.manager.confirmWindowsStoreRepair()).toBe(false);
    expect(h.manager.beginWindowsStoreRepair()).toBe(true);
    expect(h.root.innerHTML).toContain('data-system-host-store-stage="confirm-repair"');
    expect(h.root.innerHTML).toContain("data-system-host-store-repair-confirm");
    expect(h.root.innerHTML.match(/class="system-host-card-primary"/g)).toHaveLength(1);
    expect(h.manager.cancelWindowsStoreRepair()).toBe(true);
    expect(h.manager.state.snapshot).toBe(paired);
    expect(h.root.innerHTML).toContain('data-system-host-store-stage="reconnect"');
    expect(h.dependencies.revokeConnection).not.toHaveBeenCalled();
    expect(h.dependencies.requestStoreConnection).not.toHaveBeenCalled();
  });

  test("confirmed re-pairing waits for an unpaired response before requesting exactly one fresh grant", async () => {
    const h = harness();
    const revoke = deferred();
    await h.activate();
    h.dependencies.revokeConnection.mockImplementationOnce(() => revoke.promise);
    h.manager.beginWindowsStoreRepair();
    const pending = h.manager.confirmWindowsStoreRepair();
    expect(h.manager.state.busy).toBe(true);
    expect(h.root.innerHTML).toContain('data-system-host-store-stage="repairing"');
    expect(await h.manager.confirmWindowsStoreRepair()).toBe(false);
    expect(h.dependencies.revokeConnection).toHaveBeenCalledOnce();
    expect(h.dependencies.requestStoreConnection).not.toHaveBeenCalled();
    revoke.resolve(unpaired);
    expect(await pending).toBe(true);
    expect(h.manager.state.snapshot).toBe(unpaired);
    expect(h.manager.state.windowsStoreInvitation.launchUrl).toBe(receipt().launchUrl);
    expect(h.root.innerHTML).toContain('data-system-host-store-stage="open"');
    expect(h.dependencies.requestStoreConnection).toHaveBeenCalledOnce();
    expect(h.dependencies.downloadSetup).not.toHaveBeenCalled();
  });

  test.each(["rejected", "still-paired", "still-connected"])(
    "revoke %s prevents fresh grants and keeps the last verified pairing state",
    async (failure) => {
      const h = harness();
      await h.activate();
      if (failure === "rejected") h.dependencies.revokeConnection.mockRejectedValueOnce(new Error("unavailable"));
      if (failure === "still-paired") h.dependencies.revokeConnection.mockResolvedValueOnce(paired);
      if (failure === "still-connected") h.dependencies.revokeConnection.mockResolvedValueOnce({ ...unpaired, connected: true });
      h.manager.beginWindowsStoreRepair();
      expect(await h.manager.confirmWindowsStoreRepair()).toBe(false);
      expect(h.manager.state.snapshot).toBe(paired);
      expect(h.manager.state.actionError).not.toBe("");
      expect(h.manager.state.busy).toBe(false);
      expect(h.dependencies.requestStoreConnection).not.toHaveBeenCalled();
    },
  );

  test("a grant failure after successful revoke keeps the verified unpaired state available for retry", async () => {
    const h = harness();
    await h.activate();
    h.dependencies.requestStoreConnection.mockRejectedValueOnce(new Error("grant unavailable"));
    h.manager.beginWindowsStoreRepair();
    expect(await h.manager.confirmWindowsStoreRepair()).toBe(false);
    expect(h.manager.state.snapshot).toBe(unpaired);
    expect(h.manager.state.windowsStoreInvitation).toBeNull();
    expect(h.manager.state.actionError).not.toBe("");
    expect(h.root.innerHTML).toContain('data-system-host-store-stage="start"');
    expect(h.root.innerHTML).not.toContain("data-system-host-revoke");
    expect(await h.manager.connectWindowsStore()).toBe(true);
    expect(h.dependencies.revokeConnection).toHaveBeenCalledOnce();
  });

  test.each(["hidden", "reset", "environment-event", "environment-value"])(
    "a revoke response arriving after %s cannot replace state or request a grant",
    async (transition) => {
      const h = harness();
      const revoke = deferred();
      await h.activate();
      h.dependencies.revokeConnection.mockImplementationOnce(() => revoke.promise);
      h.manager.beginWindowsStoreRepair();
      const pending = h.manager.confirmWindowsStoreRepair();
      if (transition === "hidden") h.manager.setActive(false);
      if (transition === "reset") h.manager.reset();
      if (transition === "environment-value") h.changeEnvironment();
      if (transition === "environment-event") {
        h.changeEnvironment();
        h.manager.environmentChanged();
        await vi.waitFor(() => expect(h.manager.state.busy).toBe(false));
      }
      const current = h.manager.state.snapshot;
      revoke.resolve(unpaired);
      expect(await pending).toBe(false);
      expect(h.manager.state.snapshot).toBe(current);
      expect(h.manager.state.windowsStoreInvitation).toBeNull();
      expect(h.dependencies.requestStoreConnection).not.toHaveBeenCalled();
    },
  );

  test("a fresh invitation arriving after leaving the surface is not restored", async () => {
    const h = harness();
    const grant = deferred();
    await h.activate();
    h.dependencies.requestStoreConnection.mockImplementationOnce(() => grant.promise);
    h.manager.beginWindowsStoreRepair();
    const pending = h.manager.confirmWindowsStoreRepair();
    await vi.waitFor(() => expect(h.dependencies.requestStoreConnection).toHaveBeenCalledOnce());
    expect(h.manager.state.snapshot).toBe(unpaired);
    h.manager.setActive(false);
    grant.resolve(receipt());
    expect(await pending).toBe(false);
    expect(h.manager.state.windowsStoreInvitation).toBeNull();
    expect(h.root.innerHTML).not.toContain(receipt().launchUrl);
  });
});
