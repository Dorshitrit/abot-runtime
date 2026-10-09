import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { NativeAutostartOptions } from "../../computer-access/companion/autostart.js";
import type { NativeHostState } from "../../computer-access/companion/native-state.js";
import type { NotificationProcessRunner } from "../../computer-access/companion/notification-process.js";

const mocks = vi.hoisted(() => ({
  ownedRegistration: vi.fn(async () => false),
  stop: vi.fn(async () => {}),
  uninstallStartup: vi.fn(async () => {}),
  uninstallLinks: vi.fn(async () => {}),
  uninstallNotifications: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  wait: vi.fn(async () => true),
  run: vi.fn<NotificationProcessRunner>(async () => "Enabled"),
}));
vi.mock("../../cli/host-companion-startup.js", () => ({
  startDetachedCompanion: mocks.start,
  waitForNativeConnection: mocks.wait,
}));
vi.mock("../../computer-access/companion/autostart.js", () => ({
  nativeAutostartFile: () => "/fixture/startup.vbs",
  existingOwnedRegistration: mocks.ownedRegistration,
  uninstallNativeAutostart: mocks.uninstallStartup,
}));
vi.mock("../../computer-access/companion/native-build-identity.js", () => ({
  readNativeCompanionBuildId: async () => "store-build-sha256",
}));
vi.mock("../../computer-access/companion/native-replacement.js", () => ({
  stopOwnedNativeCompanion: mocks.stop,
}));
vi.mock("../../computer-access/companion/install-link-registration.js", () => ({
  uninstallCompanionInstallLinks: mocks.uninstallLinks,
}));
vi.mock("../../computer-access/companion/notification-installation.js", () => ({
  uninstallDesktopNotificationIdentity: mocks.uninstallNotifications,
}));
vi.mock("../../computer-access/companion/notification-process.js", () => ({
  runNotificationProcess: mocks.run,
}));

import { createWindowsStoreLifecycle } from "../../computer-access/companion/windows-store/lifecycle.js";

const appUserModelId = "ABotAI.Companion_publisher!Companion";
const runtimeUrl = "ws://127.0.0.1:5177";
const startup: NativeAutostartOptions = {
  platform: "win32",
  homeDir: "/fixture/user",
  appData: "/fixture/appdata",
  nodePath: "/fixture/store/node.exe",
  cliPath: "/fixture/store/companion.mjs",
  stateDir: "/fixture/user/.abot/host-companion",
};
let state: NativeHostState;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.ownedRegistration.mockResolvedValue(false);
  mocks.stop.mockResolvedValue(undefined);
  mocks.wait.mockResolvedValue(true);
  mocks.run.mockResolvedValue("Enabled");
  state = {
    directory: startup.stateDir,
    read: vi.fn(),
    write: vi.fn(),
    remove: vi.fn(async () => {}),
    setStatus: vi.fn(),
    isConnected: vi.fn(),
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

test("Store setup preserves pairing, retires the verified old owner and waits for the current build", async () => {
  const lifecycle = createWindowsStoreLifecycle({ appUserModelId });
  await lifecycle.completeStartup(state, startup, "paired-host");
  expect(mocks.ownedRegistration).toHaveBeenCalledWith("/fixture/startup.vbs");
  expect(mocks.ownedRegistration.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.stop.mock.invocationCallOrder[0]!,
  );
  expect(mocks.stop).toHaveBeenCalledWith(state.directory);
  expect(mocks.uninstallStartup).toHaveBeenCalledWith(startup);
  expect(mocks.uninstallLinks).toHaveBeenCalledWith(startup);
  expect(mocks.uninstallNotifications).toHaveBeenCalledWith(startup);
  expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.start.mock.invocationCallOrder[0]!,
  );
  expect(mocks.start).toHaveBeenCalledWith(startup);
  expect(mocks.wait).toHaveBeenCalledWith(
    state,
    "paired-host",
    "store-build-sha256",
    expect.any(Number),
  );
  expect(state.write).not.toHaveBeenCalled();
  expect(state.remove).not.toHaveBeenCalled();
});

test("an unmanaged legacy registration prevents replacement before process or registration changes", async () => {
  mocks.ownedRegistration.mockRejectedValue(new Error("unmanaged startup"));
  await expect(
    createWindowsStoreLifecycle({ appUserModelId }).completeStartup(
      state,
      startup,
      "paired-host",
    ),
  ).rejects.toThrow("unmanaged startup");
  expect(mocks.stop).not.toHaveBeenCalled();
  expect(mocks.uninstallStartup).not.toHaveBeenCalled();
  expect(mocks.uninstallLinks).not.toHaveBeenCalled();
  expect(mocks.uninstallNotifications).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
  expect(state.write).not.toHaveBeenCalled();
  expect(state.remove).not.toHaveBeenCalled();
});

test("a missing fresh connection is a setup failure and keeps the saved pairing", async () => {
  mocks.wait.mockResolvedValue(false);
  await expect(
    createWindowsStoreLifecycle({ appUserModelId }).completeStartup(
      state,
      startup,
      "paired-host",
    ),
  ).rejects.toThrow("saved pairing is preserved");
  expect(state.remove).not.toHaveBeenCalled();
  expect(state.write).not.toHaveBeenCalled();
});

test("Store disconnect removes credentials and stops only the owned process without altering package registration", async () => {
  await createWindowsStoreLifecycle({ appUserModelId }).uninstall(
    state,
    startup,
  );
  expect(state.remove).toHaveBeenCalledOnce();
  expect(mocks.stop).toHaveBeenCalledWith(state.directory);
  expect(mocks.uninstallStartup).not.toHaveBeenCalled();
  expect(mocks.uninstallLinks).not.toHaveBeenCalled();
  expect(mocks.uninstallNotifications).not.toHaveBeenCalled();
});

test.each(["linux", "darwin"] as const)(
  "the Store adapter rejects %s without OS changes",
  async (platform) => {
    await expect(
      createWindowsStoreLifecycle({ appUserModelId }).completeStartup(
        state,
        { ...startup, platform },
        "paired-host",
      ),
    ).rejects.toThrow("requires Windows");
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  },
);

test("Store notifications keep origin validation and send the configured AUMID as data", async () => {
  const session = await createWindowsStoreLifecycle({ appUserModelId })
    .createNotifications!(runtimeUrl);
  expect(session.ready).toBe(false);
  expect(mocks.run).not.toHaveBeenCalled();
  await session.refreshReadiness!(new AbortController().signal);
  expect(session.ready).toBe(true);
  const notification = {
    target: "windows",
    notificationId: "a".repeat(64),
    title: "Ready",
    body: "Finished",
    url: "/chat?environment=dev&session=session-1",
  };
  const handler = session.handlers().desktop_notification!;
  expect(
    (await handler({ ...notification, url: "https://other.example/chat" })).ok,
  ).toBe(false);
  expect(mocks.run).toHaveBeenCalledOnce();
  expect((await handler(notification)).ok).toBe(true);
  const delivery = mocks.run.mock.calls[1]![0];
  expect(JSON.parse(delivery.input!)).toMatchObject({
    appUserModelId,
    url: "http://127.0.0.1:5177/chat?environment=dev&session=session-1",
  });
  const script = Buffer.from(delivery.args.at(-1)!, "base64").toString(
    "utf16le",
  );
  expect(script).not.toContain(appUserModelId);
});

test("notification readiness follows Windows and can recover after the setting changes", async () => {
  mocks.run.mockResolvedValue("DisabledForApplication");
  const session = await createWindowsStoreLifecycle({ appUserModelId })
    .createNotifications!(runtimeUrl);
  expect(mocks.run).not.toHaveBeenCalled();
  await session.refreshReadiness!(new AbortController().signal);
  expect(session.ready).toBe(false);
  mocks.run.mockResolvedValue("Enabled");
  await session.refreshReadiness!(new AbortController().signal);
  expect(session.ready).toBe(true);
});
