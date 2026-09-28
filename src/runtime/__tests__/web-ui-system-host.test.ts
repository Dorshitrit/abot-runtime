import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createSystemHostConnectionManager } from "../../web-ui/app/components/system-host/manager.js";
// @ts-expect-error Browser-only module.
import { renderSystemHostConnection } from "../../web-ui/app/components/system-host/rendering.js";
const setupNeeded = {
  paired: false,
  connected: false,
  readiness: {
    ready: false,
    route: "setup_required",
    environment: "container",
    platforms: ["windows", "macos"],
    restartRequired: false,
  },
};
const ready = {
  paired: true,
  connected: true,
  hostId: "host",
  identity: { name: "My Mac", os: "macos", user: "owner" },
  readiness: {
    ready: true,
    route: "companion",
    environment: "container",
    platforms: [],
    restartRequired: false,
  },
};
const receipt = {
  filename: "abot-setup.cmd",
  mimeType: "text/plain",
  contentBase64: "c2VjcmV0",
  expiresAt: "2099-01-01T00:00:00Z",
  restartRequired: false,
};
const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(overrides: Record<string, unknown> = {}) {
  const listeners = new Map<string, () => void>();
  const documentRoot = {
    hidden: false,
    addEventListener: (event: string, callback: () => void) =>
      listeners.set(event, callback),
    removeEventListener: (event: string) => listeners.delete(event),
  };
  const paint = vi.fn();
  let content = "";
  const root = {
    get innerHTML() {
      return content;
    },
    set innerHTML(html: string) {
      content = html;
      paint(html);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const dependencies = {
    loadConnection: vi.fn(async () => setupNeeded),
    downloadSetup: vi.fn(async () => receipt),
    revokeConnection: vi.fn(async () => setupNeeded),
    saveDownload: vi.fn(),
    supportsConnection: vi.fn(() => true),
    schedulePoll: vi.fn(),
    cancelPoll: vi.fn(),
    documentRoot,
    ...overrides,
  };
  const manager = createSystemHostConnectionManager(dependencies);
  manager.mount(root);
  disposers.push(manager.dispose);
  async function activate() {
    manager.setActive(true);
    await vi.waitFor(() => expect(manager.state.busy).toBe(false));
  }
  return {
    manager,
    root,
    paint,
    dependencies,
    documentRoot,
    listeners,
    activate,
  };
}
describe("computer setup GUI", () => {
  test("offers explicit unpairing and returns to setup after revocation", async () => {
    const { manager, root, dependencies, activate } = harness({ loadConnection: async () => ready });
    await activate();
    expect(root.innerHTML).toContain("Unpair computer");
    expect(root.innerHTML).toContain("Saved insights are kept");
    expect(await manager.revoke()).toBe(true);
    expect(dependencies.revokeConnection).toHaveBeenCalledOnce();
    expect(manager.state.snapshot.paired).toBe(false);
    expect(root.innerHTML).not.toContain("My Mac");
    expect(root.innerHTML).toContain("Computer unpaired");
  });
  test("a connected Windows companion needing an update keeps its installer until capability readiness returns", async () => {
    const updateNeeded = {
      ...ready,
      readiness: {
        ...ready.readiness,
        ready: false,
        companionUpdateRequired: true,
        platforms: ["windows"],
      },
    };
    const { manager, root, dependencies, activate } = harness({
      loadConnection: vi.fn(async () => updateNeeded),
    });
    await activate();
    expect(root.innerHTML).toContain("Update needed");
    expect(root.innerHTML).not.toContain("Paired · offline");
    expect(root.innerHTML).toContain('data-system-host-install="windows"');
    expect(root.innerHTML).not.toContain('data-system-host-install="macos"');
    expect(await manager.install("windows")).toBe(true);
    expect(dependencies.downloadSetup).toHaveBeenCalledWith("windows");
    expect(root.innerHTML).toContain("Downloaded:");
    expect(root.innerHTML).toContain("Update needed");
    dependencies.loadConnection.mockResolvedValueOnce(ready as never);
    await manager.load();
    expect(root.innerHTML).toContain("Ready");
    expect(root.innerHTML).not.toContain("data-system-host-install=");
    expect(root.innerHTML).not.toContain("Downloaded:");
  });

  test("an incompatible newer connected companion is not displayed as offline or offered a downgrade", () => {
    const html = renderSystemHostConnection({
      snapshot: { ...ready, readiness: { ...ready.readiness, ready: false } },
      supported: true,
    });
    expect(html).toContain("Computer access unavailable");
    expect(html).not.toContain("Paired · offline");
    expect(html).not.toContain("data-system-host-install=");
  });

  test("downloads the selected platform without exposing authorization or claiming readiness", async () => {
    const { manager, root, dependencies, activate } = harness();
    await activate();
    expect(await manager.install("windows")).toBe(true);
    expect(dependencies.downloadSetup).toHaveBeenCalledWith("windows");
    expect(dependencies.saveDownload).toHaveBeenCalledWith(receipt);
    expect(root.innerHTML).toContain("Downloaded:");
    expect(root.innerHTML).toContain("Setup needed");
    expect(root.innerHTML).not.toContain("c2VjcmV0");
    expect(root.innerHTML).not.toContain("abot host");
    expect(root.innerHTML).not.toContain("pairing code");
    dependencies.loadConnection.mockResolvedValueOnce(ready as never);
    await manager.load();
    expect(root.innerHTML).toContain(">Ready<");
    expect(root.innerHTML).not.toContain("Downloaded:");
  });
  test.each(["native", "wsl_interop"])(
    "uses existing %s readiness without an installer",
    async (route) => {
      const { manager, root, dependencies, activate } = harness({
        loadConnection: async () => ({
          ...setupNeeded,
          readiness: { ...setupNeeded.readiness, ready: true, route },
        }),
      });
      await activate();
      expect(root.innerHTML).toContain(">Ready<");
      expect(root.innerHTML).toContain("No extra installation");
      expect(await manager.install("windows")).toBe(false);
      expect(dependencies.downloadSetup).not.toHaveBeenCalled();
      expect(root.innerHTML).not.toContain("data-system-host-install=");
    },
  );
  test("announces a WSL restart before download and preserves pending state during downtime", async () => {
    const snapshot = {
      ...setupNeeded,
      readiness: {
        ...setupNeeded.readiness,
        environment: "wsl",
        platforms: ["windows"],
        restartRequired: true,
      },
    };
    const { manager, root, dependencies, activate } = harness({
      loadConnection: vi.fn(async () => snapshot),
      downloadSetup: async () => ({ ...receipt, restartRequired: true }),
    });
    await activate();
    expect(root.innerHTML).toContain('class="system-host-restart" role="note"');
    expect(root.innerHTML).not.toContain('data-system-host-install="macos"');
    await manager.install("windows");
    dependencies.loadConnection.mockRejectedValueOnce(new Error("offline"));
    await manager.load();
    expect(root.innerHTML).toContain("Waiting for WSL");
    expect(root.innerHTML).toContain("Downloaded:");
  });
  test("polls only while visible and refreshes when returning without revoking the installer", async () => {
    vi.useFakeTimers();
    const { manager, dependencies, documentRoot, listeners, activate } =
      harness({ schedulePoll: setTimeout, cancelPoll: clearTimeout });
    await activate();
    await manager.install("windows");
    const initial = dependencies.loadConnection.mock.calls.length;
    documentRoot.hidden = true;
    listeners.get("visibilitychange")?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dependencies.loadConnection).toHaveBeenCalledTimes(initial);
    expect(manager.state.downloaded?.filename).toBe(receipt.filename);
    documentRoot.hidden = false;
    listeners.get("visibilitychange")?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(dependencies.loadConnection).toHaveBeenCalledTimes(initial + 1);
    expect(dependencies.revokeConnection).not.toHaveBeenCalled();
    manager.setActive(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dependencies.loadConnection).toHaveBeenCalledTimes(initial + 1);
  });
  test("discards a download response after leaving its surface", async () => {
    const pending = deferred<unknown>();
    const { manager, dependencies, activate } = harness({
      downloadSetup: () => pending.promise,
    });
    await activate();
    const installing = manager.install("windows");
    manager.setActive(false);
    manager.setActive(true);
    pending.resolve(receipt);
    expect(await installing).toBe(false);
    expect(dependencies.saveDownload).not.toHaveBeenCalled();
  });
  test("preserves bounded actionable download errors through background polling", async () => {
    const { manager, root, activate } = harness({
      downloadSetup: async () => {
        throw new Error("Use HTTPS for this setup <address>.".repeat(30));
      },
    });
    await activate();
    expect(await manager.install("windows")).toBe(false);
    await manager.load(true);
    expect(root.innerHTML).toContain(
      "Use HTTPS for this setup &lt;address&gt;",
    );
    expect(manager.state.actionError.length).toBe(500);
  });
  test("discards status after disposal and serializes conflicting actions", async () => {
    const pending = deferred<unknown>();
    const { manager, dependencies } = harness({
      loadConnection: () => pending.promise,
    });
    const loading = manager.load();
    expect(await manager.revoke()).toBe(false);
    expect(dependencies.revokeConnection).not.toHaveBeenCalled();
    manager.dispose();
    pending.resolve(ready);
    expect(await loading).toBe(false);
    expect(manager.state.snapshot).toBeNull();
  });
  test("keeps unchanged background checks silent and clears readiness on reset", async () => {
    const onChange = vi.fn();
    const { manager, root, paint, dependencies, activate } = harness({
      onChange,
    });
    dependencies.loadConnection.mockResolvedValueOnce(ready as never);
    await activate();
    expect(manager.state.snapshot).toEqual(ready);
    const pending = deferred<never>();
    dependencies.loadConnection.mockImplementationOnce(() => pending.promise);
    onChange.mockClear();
    paint.mockClear();
    const refresh = manager.load(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(paint).not.toHaveBeenCalled();
    expect(manager.state.busy).toBe(false);
    expect(root.innerHTML).toContain(">Ready<");
    expect(await manager.load(true)).toBe(false);
    expect(dependencies.loadConnection).toHaveBeenCalledTimes(2);
    pending.resolve({ ...ready } as never);
    expect(await refresh).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(paint).not.toHaveBeenCalled();
    const delayed = deferred<never>();
    dependencies.loadConnection.mockImplementationOnce(() => delayed.promise);
    const discarded = manager.load(true);
    manager.reset();
    expect(manager.state.snapshot).toBeNull();
    expect(manager.state.statusUnavailable).toBe(false);
    delayed.resolve(ready as never);
    expect(await discarded).toBe(false);
    expect(manager.state.snapshot).toBeNull();
  });
  test("announces background status changes, failure and recovery only when they change the display", async () => {
    const { manager, root, paint, dependencies, activate } = harness();
    await activate();
    paint.mockClear();
    dependencies.loadConnection.mockResolvedValueOnce(ready as never);
    await manager.load(true);
    expect(root.innerHTML).toContain(">Ready<");
    expect(paint).toHaveBeenCalledOnce();
    dependencies.loadConnection.mockRejectedValueOnce(new Error("offline"));
    await manager.load(true);
    expect(root.innerHTML).toContain("Status unavailable");
    expect(root.innerHTML).not.toContain(
      "Your computer is connected and ready",
    );
    expect(paint).toHaveBeenCalledTimes(2);
    dependencies.loadConnection.mockRejectedValueOnce(new Error("offline"));
    await manager.load(true);
    expect(paint).toHaveBeenCalledTimes(2);
    dependencies.loadConnection.mockResolvedValueOnce(ready as never);
    await manager.load(true);
    expect(root.innerHTML).toContain(">Ready<");
    expect(paint).toHaveBeenCalledTimes(3);
  });
  test.each([
    {
      action: "load",
      dependency: "loadConnection",
      args: [],
      result: setupNeeded,
    },
    {
      action: "install",
      dependency: "downloadSetup",
      args: ["windows"],
      result: receipt,
    },
    {
      action: "revoke",
      dependency: "revokeConnection",
      args: [],
      result: setupNeeded,
    },
  ] as const)(
    "$action takes priority over a background check without accepting its late result",
    async ({ action, dependency, args, result }) => {
      const poll = deferred<never>();
      const foreground = deferred<never>();
      const { manager, root, dependencies, activate } = harness();
      await activate();
      dependencies.loadConnection.mockImplementationOnce(() => poll.promise);
      const polling = manager.load(true);
      dependencies[dependency].mockImplementationOnce(() => foreground.promise);
      const acting = manager[action](...args);
      expect(manager.state.busy).toBe(true);
      expect(await manager.revoke()).toBe(false);
      poll.resolve(ready as never);
      expect(await polling).toBe(false);
      expect(manager.state.busy).toBe(true);
      expect(manager.state.snapshot).toEqual(setupNeeded);
      foreground.resolve(result as never);
      expect(await acting).toBe(true);
      expect(manager.state.busy).toBe(false);
      expect(root.innerHTML).toContain("Setup needed");
    },
  );
  test("keeps the paired identity when revoke fails and does not expose backend payloads", async () => {
    const { manager, root, activate } = harness({
      loadConnection: async () => ready,
      revokeConnection: async () => {
        throw new Error("private-payload");
      },
    });
    await activate();
    expect(await manager.revoke()).toBe(false);
    expect(root.innerHTML).toContain("My Mac");
    expect(root.innerHTML).toContain("could not be revoked");
    expect(root.innerHTML).not.toContain("private-payload");
  });
  test("bridge mode and unknown WSL distribution offer no setup action", async () => {
    const { manager, root, dependencies } = harness({
      supportsConnection: () => false,
    });
    expect(await manager.load()).toBe(false);
    expect(root.innerHTML).toContain("local Runtime backend");
    expect(dependencies.loadConnection).not.toHaveBeenCalled();
    const html = renderSystemHostConnection({
      snapshot: {
        ...setupNeeded,
        readiness: {
          ...setupNeeded.readiness,
          platforms: [],
          message: "Unknown distribution",
        },
      },
      supported: true,
    });
    expect(html).toContain("Unknown distribution");
    expect(html).not.toContain("data-system-host-install=");
  });
  test("escapes host identity and readiness feedback", () => {
    const html = renderSystemHostConnection({
      snapshot: {
        ...ready,
        identity: { name: "<script>bad</script>" },
        readiness: { ...ready.readiness, ready: false, message: "<notice>" },
      },
      supported: true,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;notice&gt;");
  });
});
