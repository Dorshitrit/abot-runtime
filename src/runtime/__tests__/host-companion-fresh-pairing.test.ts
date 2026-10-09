import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HostCompanionLifecycle } from "../../cli/host-companion-lifecycle.js";
import type { NativeHostConnection } from "../../computer-access/companion/native-state.js";
import type { NativeSessionOptions } from "../../computer-access/companion/native-session.js";

const mocks = vi.hoisted(() => ({
  saved: undefined as NativeHostConnection | undefined,
  state: { directory: "/fixture/private-state", read: vi.fn(), write: vi.fn() },
  connect: vi.fn<(options: NativeSessionOptions) => Promise<string>>(),
  stop: vi.fn(async () => {}),
}));
vi.mock("../../computer-access/companion/native-replacement.js", () => ({
  stopOwnedNativeCompanion: mocks.stop,
}));
vi.mock("../../computer-access/companion/native-state.js", () => ({
  createNativeHostState: () => mocks.state,
}));
vi.mock("../../computer-access/companion/native-session.js", () => ({
  connectNativeHost: mocks.connect,
}));
import { runHostCompanionCli } from "../../cli/host-companion.js";

const saved: NativeHostConnection = {
  version: 1, url: "ws://127.0.0.1:5177",
  hostId: "317ec6e1-1148-47c7-85a2-dd6acac9fbe2", credential: "a".repeat(43),
};
const newHostId = "317ec6e1-1148-47c7-85a2-dd6acac9fbe3";
const code = "b".repeat(43);
const lifecycle: HostCompanionLifecycle = {
  assertStartupSupported: vi.fn(),
  completeStartup: vi.fn(async () => {}),
  uninstall: vi.fn(async () => {}),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.stop.mockResolvedValue(undefined);
  mocks.saved = saved;
  mocks.state.read.mockImplementation(async () => mocks.saved);
  mocks.state.write.mockImplementation(async (value: NativeHostConnection) => { mocks.saved = value; });
  mocks.connect.mockImplementation(async (options) => {
    expect(mocks.saved).toBe(saved);
    await options.onPaired(newHostId, "c".repeat(43));
    return "disconnected";
  });
});
afterEach(() => vi.restoreAllMocks());

test("fresh Store consent consumes a new grant before replacing stale same-origin pairing", async () => {
  await runHostCompanionCli(["connect", "--url", "http://127.0.0.1:5177"], {
    lifecycle, pairingCode: code, pairingMode: "fresh-grant",
  });
  expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(mocks.state.directory);
  expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(mocks.connect.mock.invocationCallOrder[0]!);
  expect(mocks.connect).toHaveBeenCalledOnce();
  expect(mocks.connect.mock.calls[0]![0]).toMatchObject({ url: saved.url, authorization: code });
  expect(mocks.saved).toEqual({ ...saved, hostId: newHostId, credential: "c".repeat(43) });
  expect(lifecycle.completeStartup).toHaveBeenCalledWith(mocks.state, expect.any(Object), newHostId);
  expect(mocks.state.write.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(lifecycle.completeStartup).mock.invocationCallOrder[0]!,
  );
});

test("rejected fresh grant preserves the previous credential and does not start a companion", async () => {
  mocks.connect.mockResolvedValue("authorization_rejected");
  await expect(runHostCompanionCli(["connect", "--url", "http://127.0.0.1:5177"], {
    lifecycle, pairingCode: code, pairingMode: "fresh-grant",
  })).rejects.toThrow("Pairing did not complete");
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(mocks.saved).toBe(saved);
  expect(mocks.state.write).not.toHaveBeenCalled();
  expect(lifecycle.completeStartup).not.toHaveBeenCalled();
});

test("fresh consent keeps the existing restriction against silently replacing another Runtime", async () => {
  await expect(runHostCompanionCli(["connect", "--url", "http://127.0.0.1:5178"], {
    lifecycle, pairingCode: code, pairingMode: "fresh-grant",
  })).rejects.toThrow("already paired");
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.stop).not.toHaveBeenCalled();
  expect(mocks.saved).toBe(saved);
});

test.each([{}, { pairingCode: code }, { pairingCode: code, upgradeHostId: saved.hostId }])(
  "existing callers and host-bound upgrades retain saved pairing %#", async (options) => {
    await runHostCompanionCli(["connect", "--url", "http://127.0.0.1:5177"], { lifecycle, ...options });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.state.write).not.toHaveBeenCalled();
    expect(lifecycle.completeStartup).toHaveBeenCalledWith(mocks.state, expect.any(Object), saved.hostId);
  },
);

test.each([
  { options: {}, error: "requires a pairing grant" },
  { options: { pairingCode: code, upgradeHostId: saved.hostId }, error: "cannot carry an upgrade identity" },
])("fresh mode rejects invalid internal combinations before any exchange %#", async ({ options, error }) => {
  await expect(runHostCompanionCli(["connect", "--url", "http://127.0.0.1:5177"], {
    lifecycle, pairingMode: "fresh-grant", ...options,
  })).rejects.toThrow(error);
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.state.write).not.toHaveBeenCalled();
  expect(lifecycle.completeStartup).not.toHaveBeenCalled();
});

test("failure to retire the verified old process blocks exchange without replacing credentials", async () => {
  mocks.stop.mockRejectedValue(new Error("owned process could not stop"));
  await expect(runHostCompanionCli(["connect", "--url", "http://127.0.0.1:5177"], {
    lifecycle, pairingCode: code, pairingMode: "fresh-grant",
  })).rejects.toThrow("owned process could not stop");
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.state.write).not.toHaveBeenCalled();
  expect(lifecycle.completeStartup).not.toHaveBeenCalled();
  expect(mocks.saved).toBe(saved);
});
