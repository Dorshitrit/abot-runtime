import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { NativeAutostartOptions } from "../../computer-access/companion/autostart.js";
import type { NativeHostState } from "../../computer-access/companion/native-state.js";

const mocks = vi.hoisted(() => ({
  prepare:
    vi.fn<
      (options: NativeAutostartOptions) => Promise<NativeAutostartOptions>
    >(),
  stop: vi.fn(async () => {}),
  registration: vi.fn(async () => false),
  install: vi.fn(async () => ({ started: true })),
  notify: vi.fn(async () => {}),
  spawn: vi.fn(),
}));

vi.mock(
  "../../computer-access/companion/native-runtime-installation.js",
  () => ({
    prepareNativeCompanionRuntime: mocks.prepare,
  }),
);
vi.mock("../../computer-access/companion/native-replacement.js", () => ({
  stopOwnedNativeCompanion: mocks.stop,
}));
vi.mock("../../computer-access/companion/native-build-identity.js", () => ({
  readNativeCompanionBuildId: vi.fn(async () => "current-bundle"),
}));
vi.mock("../../computer-access/companion/autostart.js", () => ({
  nativeAutostartFile: vi.fn(() => "/fixture/owned-startup"),
  existingOwnedRegistration: mocks.registration,
  installNativeAutostart: mocks.install,
}));
vi.mock("../../computer-access/companion/notification-installation.js", () => ({
  installDesktopNotificationIdentity: mocks.notify,
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import { completeHostCompanionStartup } from "../../cli/host-companion-startup.js";

const startup: NativeAutostartOptions = {
  platform: "darwin",
  homeDir: "/fixture/home",
  stateDir: "/fixture/private-state",
  nodePath: "/fixture/nvm/node",
  cliPath: "/fixture/companion.mjs",
  uid: 501,
};
const paired = {
  version: 1 as const,
  url: "ws://abot.localhost:5177",
  hostId: "paired-host",
  credential: "private",
};
let state: NativeHostState;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.prepare.mockImplementation(async (options) =>
    options.platform === "darwin"
      ? { ...options, nodePath: join(options.stateDir, "runtime", "node") }
      : options,
  );
  mocks.install.mockResolvedValue({ started: true });
  state = {
    directory: startup.stateDir,
    read: vi.fn(async () => paired),
    write: vi.fn(),
    remove: vi.fn(),
    setStatus: vi.fn(),
    isConnected: vi.fn(async () => true),
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

test("prepares after verified stop and uses managed options for notification/startup before ready handshake", async () => {
  await completeHostCompanionStartup(state, startup, paired.hostId);
  const managedOptions = {
    ...startup,
    nodePath: join(startup.stateDir, "runtime", "node"),
  };
  expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.prepare.mock.invocationCallOrder[0]!,
  );
  expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.notify.mock.invocationCallOrder[0]!,
  );
  expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.install.mock.invocationCallOrder[0]!,
  );
  expect(mocks.notify).toHaveBeenCalledWith(managedOptions, paired.url);
  expect(mocks.install).toHaveBeenCalledWith(managedOptions);
  expect(state.isConnected).toHaveBeenCalledWith(
    paired.hostId,
    "current-bundle",
    expect.any(Number),
  );
  expect(state.write).not.toHaveBeenCalled();
  expect(state.remove).not.toHaveBeenCalled();
});

test.each(["win32", "linux"] as const)(
  "preserves %s startup options",
  async (platform) => {
    const original = { ...startup, platform };
    await completeHostCompanionStartup(state, original, paired.hostId);
    expect(mocks.install).toHaveBeenCalledWith(original);
    expect(mocks.notify).toHaveBeenCalledWith(original, paired.url);
  },
);

test("detached fallback receives the same managed executable", async () => {
  mocks.install.mockResolvedValue({ started: false });
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  await completeHostCompanionStartup(state, startup, paired.hostId);
  expect(mocks.spawn).toHaveBeenCalledWith(
    join(startup.stateDir, "runtime", "node"),
    [startup.cliPath, "host", "run"],
    expect.objectContaining({ detached: true, stdio: "ignore" }),
  );
});

test("failed relocation preserves pairing and does not register or launch an unstable executable", async () => {
  mocks.prepare.mockRejectedValue(new Error("safe relocation failure"));
  await expect(
    completeHostCompanionStartup(state, startup, paired.hostId),
  ).rejects.toThrow("safe relocation failure");
  expect(mocks.notify).not.toHaveBeenCalled();
  expect(mocks.install).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(state.write).not.toHaveBeenCalled();
  expect(state.remove).not.toHaveBeenCalled();
  expect(await state.read()).toBe(paired);
});

test("unverified existing ownership stops before runtime preparation", async () => {
  mocks.stop.mockRejectedValue(new Error("unverified companion owner"));
  await expect(
    completeHostCompanionStartup(state, startup, paired.hostId),
  ).rejects.toThrow("unverified companion owner");
  expect(mocks.prepare).not.toHaveBeenCalled();
});
