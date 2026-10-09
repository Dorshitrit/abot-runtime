import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  removeCredential: vi.fn(async () => {}),
  uninstallStartup: vi.fn(async () => {}),
  uninstallLinks: vi.fn(async () => {}),
  uninstallNotifications: vi.fn(async () => {}),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(async () => {}),
}));
vi.mock("../../computer-access/companion/native-state.js", () => ({
  createNativeHostState: () => ({
    directory: "/fixture/private-host",
    remove: mocks.removeCredential,
  }),
}));
vi.mock(
  "../../computer-access/companion/autostart.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../computer-access/companion/autostart.js")
    >()),
    uninstallNativeAutostart: mocks.uninstallStartup,
  }),
);
vi.mock("../../computer-access/companion/install-link-registration.js", () => ({
  uninstallCompanionInstallLinks: mocks.uninstallLinks,
}));
vi.mock("../../computer-access/companion/notification-installation.js", () => ({
  uninstallDesktopNotificationIdentity: mocks.uninstallNotifications,
}));
vi.mock("../adapters/long-term-memory/file-lock/acquisition.js", () => ({
  acquireFileLock: mocks.acquireLock,
}));
vi.mock(
  "../../computer-access/companion/process-owner-identity.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../computer-access/companion/process-owner-identity.js")
    >()),
    requireCurrentProcessOwnerIdentity: vi.fn(async () => ({
      pid: 123,
      startTime: "fixture",
    })),
  }),
);
import { runHostCompanionCli } from "../../cli/host-companion.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.uninstallLinks.mockResolvedValue(undefined);
  mocks.acquireLock.mockResolvedValue(mocks.releaseLock);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

test.each(["disconnect", "uninstall"])(
  "%s removes credentials and startup even when optional protocol cleanup fails",
  async (command) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.uninstallLinks.mockRejectedValue(
      new Error("Installation-link registration is not owned."),
    );
    await expect(runHostCompanionCli([command])).resolves.toBeUndefined();
    expect(mocks.removeCredential).toHaveBeenCalledOnce();
    expect(mocks.uninstallStartup).toHaveBeenCalledOnce();
    expect(mocks.uninstallNotifications).toHaveBeenCalledOnce();
    expect(mocks.acquireLock).toHaveBeenCalledOnce();
    expect(mocks.releaseLock).toHaveBeenCalledOnce();
    expect(mocks.releaseLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.uninstallLinks.mock.invocationCallOrder[0]!,
    );
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("not owned"));
  },
);

test("successful disconnect removes the link registration without a warning", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  await runHostCompanionCli(["disconnect"]);
  expect(mocks.uninstallLinks).toHaveBeenCalledOnce();
  expect(warning).not.toHaveBeenCalled();
});
