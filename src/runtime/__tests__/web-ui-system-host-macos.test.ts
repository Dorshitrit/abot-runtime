import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createSystemHostConnectionManager } from "../../web-ui/app/components/system-host/manager.js";
// @ts-expect-error Browser-only module.
import { macConnectionCommand } from "../../web-ui/app/components/system-host/macos-setup.js";

const setup = {
  paired: false,
  connected: false,
  readiness: {
    ready: false,
    platforms: ["macos"],
    localSetupAvailable: true,
    localComputerName: "Owner's Mac <desktop>",
  },
};
const ready = {
  paired: true,
  connected: true,
  readiness: { ready: true, platforms: [] },
};
const pairing = { code: "A".repeat(43), expiresAt: "2099-01-01T00:00:00Z" };
const disposers: Array<() => void> = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

function harness(snapshot: unknown = setup) {
  const clicks = new Map<string, () => void>();
  const root = {
    innerHTML: "",
    querySelector: (selector: string) => ({
      addEventListener: (_: string, listener: () => void) =>
        clicks.set(selector, listener),
    }),
    querySelectorAll: () => [],
  };
  const dependencies = {
    loadConnection: vi.fn(async (): Promise<unknown> => snapshot),
    connectLocal: vi.fn(async (): Promise<unknown> => ({ ok: true })),
    createPairing: vi.fn(async (): Promise<unknown> => pairing),
    downloadSetup: vi.fn(async () => ({ filename: "abot.cmd" })),
    revokeConnection: vi.fn(async () => setup),
    saveDownload: vi.fn(),
    getRuntimeOrigin: () => "http://localhost:5184",
    schedulePoll: vi.fn(),
    cancelPoll: vi.fn(),
    documentRoot: {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  };
  const manager = createSystemHostConnectionManager(dependencies);
  manager.mount(root);
  disposers.push(manager.dispose);
  async function activate() {
    manager.setActive(true);
    await vi.waitFor(() => expect(manager.state.busy).toBe(false));
  }
  return { root, clicks, manager, dependencies, activate };
}

test("local Mac button invokes installed connection and checks fresh readiness without downloading or pairing in the browser", async () => {
  const h = harness();
  await h.activate();
  expect(h.root.innerHTML).toContain("Connect this Mac");
  expect(h.root.innerHTML).toContain("&lt;desktop&gt;");
  expect(h.root.innerHTML).toContain("future sign-ins");
  expect(h.root.innerHTML).not.toContain("data-system-host-install");
  h.dependencies.loadConnection.mockResolvedValueOnce(ready);
  h.clicks.get('[data-system-host-mac="local"]')!();
  await vi.waitFor(() => expect(h.root.innerHTML).toContain(">Ready<"));
  expect(h.dependencies.connectLocal).toHaveBeenCalledOnce();
  expect(h.dependencies.createPairing).not.toHaveBeenCalled();
  expect(h.dependencies.downloadSetup).not.toHaveBeenCalled();
  expect(await h.manager.install("macos")).toBe(false);
  expect(await h.manager.pairMac()).toBe(false);
});

test("local repair reuses the connect endpoint without revocation or a browser pairing grant", async () => {
  const h = harness({
    ...setup,
    paired: true,
    readiness: { ...setup.readiness, companionUpdateRequired: true },
  });
  await h.activate();
  expect(h.root.innerHTML).toContain("Repair Mac connection");
  expect(await h.manager.connectMac()).toBe(true);
  expect(h.dependencies.connectLocal).toHaveBeenCalledOnce();
  expect(h.dependencies.revokeConnection).not.toHaveBeenCalled();
  expect(h.dependencies.createPairing).not.toHaveBeenCalled();
});

test("manual Mac pairing shows a separate code and exact loopback command while preserving other platform downloads", async () => {
  const h = harness({
    ...setup,
    readiness: {
      ...setup.readiness,
      localSetupAvailable: false,
      platforms: ["windows", "macos", "linux"],
    },
  });
  await h.activate();
  expect(h.root.innerHTML).toContain('data-system-host-install="windows"');
  expect(h.root.innerHTML).toContain('data-system-host-install="linux"');
  expect(h.root.innerHTML).not.toContain('data-system-host-install="macos"');
  expect(await h.manager.connectMac()).toBe(false);
  h.clicks.get('[data-system-host-mac="manual"]')!();
  await vi.waitFor(() =>
    expect(h.manager.state.manualMac?.code).toBe(pairing.code),
  );
  expect(h.manager.state.manualMac.command).toBe(
    "abot host connect --url 'http://localhost:5184'",
  );
  expect(h.manager.state.manualMac.command).not.toContain(pairing.code);
  expect(h.root.innerHTML).toContain(pairing.code);
  expect(h.root.innerHTML).toContain("Code expires");
  expect(h.dependencies.createPairing).toHaveBeenCalledOnce();
  expect(h.dependencies.downloadSetup).not.toHaveBeenCalled();
  expect(await h.manager.install("windows")).toBe(true);
  expect(h.manager.state.manualMac).toBeNull();
  expect(h.root.innerHTML).not.toContain(pairing.code);
  expect(await h.manager.install("linux")).toBe(true);
  expect(h.dependencies.downloadSetup.mock.calls).toEqual([
    ["windows"],
    ["linux"],
  ]);
});

test("manual repair uses saved credentials and never creates a grant or unpairs the existing Mac", async () => {
  const h = harness({
    ...setup,
    paired: true,
    readiness: { ...setup.readiness, localSetupAvailable: false },
  });
  await h.activate();
  expect(await h.manager.pairMac()).toBe(true);
  expect(h.manager.state.manualMac.repair).toBe(true);
  expect(h.manager.state.manualMac.code).toBeUndefined();
  expect(h.root.innerHTML).toContain("Mac already paired");
  expect(h.dependencies.createPairing).not.toHaveBeenCalled();
  expect(h.dependencies.revokeConnection).not.toHaveBeenCalled();
});

test("manual repair uses the saved URL from status rather than the current browser origin", async () => {
  const h = harness({
    ...setup,
    paired: true,
    readiness: { ...setup.readiness, localSetupAvailable: false },
  });
  await h.activate();
  expect(await h.manager.pairMac()).toBe(true);
  expect(h.manager.state.manualMac.command).toBe(
    "abot host status\nabot host connect --url '<saved-runtime-url>'",
  );
  expect(h.root.innerHTML).toContain(
    "exact saved <code>url</code> shown by status",
  );
  expect(h.root.innerHTML).not.toContain("http://localhost:5184");
  expect(h.dependencies.createPairing).not.toHaveBeenCalled();
  expect(h.dependencies.revokeConnection).not.toHaveBeenCalled();
});

test("leaving the surface clears pairing material and discards an outstanding pairing response", async () => {
  const h = harness({
    ...setup,
    readiness: { ...setup.readiness, localSetupAvailable: false },
  });
  await h.activate();
  await h.manager.pairMac();
  h.manager.setActive(false);
  expect(h.manager.state.manualMac).toBeNull();
  expect(h.root.innerHTML).not.toContain(pairing.code);
  await h.activate();
  const pending = deferred<unknown>();
  h.dependencies.createPairing.mockImplementationOnce(() => pending.promise);
  const pairingRequest = h.manager.pairMac();
  h.manager.setActive(false);
  h.manager.setActive(true);
  pending.resolve(pairing);
  expect(await pairingRequest).toBe(false);
  expect(h.manager.state.manualMac).toBeNull();
  expect(h.root.innerHTML).not.toContain(pairing.code);
});

test("local connection response after disposal cannot reload or change the reset surface", async () => {
  const h = harness();
  await h.activate();
  const pending = deferred<unknown>();
  h.dependencies.connectLocal.mockImplementationOnce(() => pending.promise);
  const connection = h.manager.connectMac();
  expect(await h.manager.revoke()).toBe(false);
  h.manager.dispose();
  pending.resolve({ ok: true });
  expect(await connection).toBe(false);
  expect(h.dependencies.loadConnection).toHaveBeenCalledOnce();
  expect(h.manager.state.snapshot).toBeNull();
});

test("reset removes a displayed pairing grant from both state and the rendered panel", async () => {
  const h = harness({
    ...setup,
    readiness: { ...setup.readiness, localSetupAvailable: false },
  });
  await h.activate();
  await h.manager.pairMac();
  expect(h.root.innerHTML).toContain(pairing.code);
  h.manager.reset();
  expect(h.manager.state.manualMac).toBeNull();
  expect(h.root.innerHTML).not.toContain(pairing.code);
});

test("readiness confirmation clears the manual code and malformed or expired codes are not displayed", async () => {
  const h = harness({
    ...setup,
    readiness: { ...setup.readiness, localSetupAvailable: false },
  });
  await h.activate();
  h.dependencies.createPairing.mockResolvedValueOnce({
    code: "<script>",
    expiresAt: pairing.expiresAt,
  });
  expect(await h.manager.pairMac()).toBe(false);
  expect(h.root.innerHTML).not.toContain("<script>");
  h.dependencies.createPairing.mockResolvedValueOnce({
    ...pairing,
    expiresAt: "2000-01-01T00:00:00Z",
  });
  expect(await h.manager.pairMac()).toBe(true);
  expect(h.root.innerHTML).not.toContain(pairing.code);
  expect(h.root.innerHTML).toContain("expired");
  await h.manager.pairMac();
  h.dependencies.loadConnection.mockResolvedValueOnce(ready);
  await h.manager.load();
  expect(h.manager.state.manualMac).toBeNull();
  expect(h.root.innerHTML).not.toContain(pairing.code);
});

test("remote browser origins require an explicit local forward and shell-sensitive localhost aliases are quoted", () => {
  const remote = macConnectionCommand("https://runtime.example:5184");
  expect(remote.needsForwarding).toBe(true);
  expect(remote.command).toContain("localhost:<forwarded-port>");
  expect(remote.command).not.toContain("runtime.example");
  expect(macConnectionCommand("http://[::1]:5184")).toEqual({
    command: "abot host connect --url 'http://[::1]:5184'",
    needsForwarding: false,
  });
  expect(macConnectionCommand("http://a$(id).localhost:5184").command).toBe(
    "abot host connect --url 'http://a$(id).localhost:5184'",
  );
});


test("ready Mac connection includes separate permission guidance for its installed runtime", async () => {
  const h = harness({ ...ready, identity: { os: "macos" }, companion: { installedVersion: 6 } });
  await h.activate();
  expect(h.root.innerHTML).toContain(">Ready<");
  expect(h.root.innerHTML).toContain("data-system-host-mac-permissions");
  expect(h.root.innerHTML).toContain("~/.abot/host-companion/runtime/node");
  expect(h.root.innerHTML).not.toContain("data-system-host-mac=\"local\"");
});

test.each([undefined, 5])("does not show a managed permission path to an old Mac companion: %s", async version => {
  const h = harness({ ...ready, identity: { os: "macos" }, companion: { installedVersion: version } });
  await h.activate();
  expect(h.root.innerHTML).not.toContain("~/.abot/host-companion/runtime/node");
  expect(h.root.innerHTML).not.toContain("data-system-host-mac-permissions");
});

test.each(["windows", "linux"])("does not add Mac permission guidance to %s", async os => {
  const h = harness({ ...ready, identity: { os }, companion: { installedVersion: 6 } });
  await h.activate();
  expect(h.root.innerHTML).not.toContain("data-system-host-mac-permissions");
});
