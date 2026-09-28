import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { NativeAutostartOptions } from "../../computer-access/companion/autostart.js";
import {
  installDesktopNotificationIdentity,
  uninstallDesktopNotificationIdentity,
  linuxNotificationDesktopPath,
  notificationLocationsFromStartup,
} from "../../computer-access/companion/notification-installation.js";
import { hasDesktopNotificationSupport } from "../../computer-access/companion/notification-readiness.js";
import {
  notificationInstallDirectory,
  macNotificationAppPath,
} from "../../computer-access/companion/notification-locations.js";
import type { NotificationProcessRunner } from "../../computer-access/companion/notification-process.js";
import { withWindowsNotificationDirectoryPublication } from "./support/notification-directory-publication.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(
  platform: NodeJS.Platform,
): Promise<NativeAutostartOptions> {
  const artifacts = resolve(".codex/artifacts/notifications-20260927");
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "native-install-"));
  directories.push(directory);
  return {
    platform,
    homeDir: directory,
    stateDir: join(directory, ".abot", "host-companion"),
    nodePath: "/fixture/node",
    cliPath: "/fixture/companion.mjs",
    appData: join(directory, "appdata"),
  };
}

test("Linux installs a named desktop identity, reports actionable dependency failure, and removes only owned registration", async () => {
  const startup = await fixture("linux");
  vi.stubEnv("XDG_DATA_HOME", join(startup.homeDir, "xdg-data"));
  vi.stubEnv("DISPLAY", ":88");
  const locations = notificationLocationsFromStartup(startup);
  const run = vi.fn<NotificationProcessRunner>(async (input) =>
    input.file === "notify-send"
      ? "--wait --action --print-id"
      : "([\'actions\'],)",
  );
  await installDesktopNotificationIdentity(
    startup,
    "ws://abot.localhost:5199",
    withWindowsNotificationDirectoryPublication(run, startup.homeDir),
  );
  const desktop = linuxNotificationDesktopPath(locations);
  const source = await readFile(desktop, "utf8");
  expect(source).toContain("Name=ABot");
  expect(source).toContain("http://abot.localhost:5199/notifications");
  expect(await hasDesktopNotificationSupport("linux", locations, run)).toBe(
    true,
  );
  const failure = vi.fn<NotificationProcessRunner>(async () => {
    throw new Error("ENOENT");
  });
  expect(await hasDesktopNotificationSupport("linux", locations, failure)).toBe(
    false,
  );
  const missingBus = vi.fn<NotificationProcessRunner>(async (input) => {
    if (input.file === "gdbus") throw new Error("gdbus unavailable");
    return "--wait --action --print-id";
  });
  expect(
    await hasDesktopNotificationSupport("linux", locations, missingBus),
  ).toBe(false);
  await uninstallDesktopNotificationIdentity(startup, run);
  await expect(access(desktop)).rejects.toThrow();
  await expect(
    access(notificationInstallDirectory(locations)),
  ).rejects.toThrow();
});

test("Linux missing action support leaves notifications unavailable without creating a readiness receipt", async () => {
  const startup = await fixture("linux");
  const run = vi.fn<NotificationProcessRunner>(async () => "--help");
  await expect(
    installDesktopNotificationIdentity(
      startup,
      "ws://abot.localhost:5199",
      withWindowsNotificationDirectoryPublication(run, startup.homeDir),
    ),
  ).rejects.toThrow("action support");
  expect(
    await hasDesktopNotificationSupport(
      "linux",
      notificationLocationsFromStartup(startup),
      run,
    ),
  ).toBe(false);
});

test("notification cleanup refuses an unmanaged directory and preserves its data", async () => {
  const startup = await fixture("linux");
  const directory = notificationInstallDirectory(
    notificationLocationsFromStartup(startup),
  );
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, ".owner"), "Someone else's registration");
  await writeFile(join(directory, "preserve.txt"), "user data");
  await expect(uninstallDesktopNotificationIdentity(startup)).rejects.toThrow(
    "not_owned",
  );
  expect(await readFile(join(directory, "preserve.txt"), "utf8")).toBe(
    "user data",
  );
});

test("Mac app installation registers ABot with stable identity and signs before activation; uninstall stops helper first", async () => {
  const startup = await fixture("darwin");
  const calls: { file: string; args: readonly string[] }[] = [];
  const run: NotificationProcessRunner = async (input) => {
    calls.push(input);
    if (input.file === "/usr/bin/osacompile") {
      const app = input.args[input.args.indexOf("-o") + 1]!;
      await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
      await writeFile(
        join(app, "Contents", "MacOS", "applet"),
        "fixture compiled native applet",
      );
    }
    return "";
  };
  await installDesktopNotificationIdentity(
    startup,
    "ws://abot.localhost:5199",
    withWindowsNotificationDirectoryPublication(run, startup.homeDir),
  );
  const locations = notificationLocationsFromStartup(startup);
  const app = macNotificationAppPath(locations);
  const plist = await readFile(join(app, "Contents", "Info.plist"), "utf8");
  expect(plist).toContain("<string>com.abot.notifications</string>");
  expect(plist).toContain("<string>ABot</string>");
  expect(plist).toContain("<key>OSAAppletStayOpen</key><true/>");
  expect(
    calls.findIndex((call) => call.file.endsWith("/codesign")),
  ).toBeLessThan(calls.findIndex((call) => call.file.endsWith("/lsregister")));
  expect(await hasDesktopNotificationSupport("macos", locations, run)).toBe(
    true,
  );
  calls.length = 0;
  await uninstallDesktopNotificationIdentity(startup, run);
  expect(calls[0]?.file).toBe("/usr/bin/osascript");
  expect(calls[1]?.args).toEqual(["-u", app]);
  await expect(access(app)).rejects.toThrow();
});

test("Windows registration uses the ABot AUMID and shortcut stub CLSID; uninstall has an ownership guard", async () => {
  const startup = await fixture("win32");
  const run = vi.fn<NotificationProcessRunner>(async () => "");
  await installDesktopNotificationIdentity(
    startup,
    "ws://abot.localhost:5199",
    withWindowsNotificationDirectoryPublication(run, startup.homeDir),
  );
  const first = run.mock.calls[0]![0];
  const script = Buffer.from(first.args.at(-1)!, "base64").toString("utf16le");
  expect(script).toContain("ABot Notifications.lnk");
  expect(script).toContain("com.abot.notifications");
  expect(script).toContain("E13CEAD1-5B60-4B49-9537-54836F743F2E");
  expect(script).toContain("notification_registration_not_owned");
  expect(JSON.parse(first.input!)).toEqual({
    action: "install",
    url: "http://abot.localhost:5199/notifications",
  });
  await uninstallDesktopNotificationIdentity(startup, run);
  expect(JSON.parse(run.mock.calls[1]![0].input!)).toEqual({
    action: "uninstall",
  });
});

test("uninstall cleans an interrupted Mac setup that never produced an app", async () => {
  const startup = await fixture("darwin");
  const run = vi.fn<NotificationProcessRunner>(async () => {
    throw new Error("compile interrupted");
  });
  await expect(
    installDesktopNotificationIdentity(
      startup,
      "ws://abot.localhost:5199",
      withWindowsNotificationDirectoryPublication(run, startup.homeDir),
    ),
  ).rejects.toThrow("compile interrupted");
  run.mockReset();
  run.mockResolvedValue("");
  await uninstallDesktopNotificationIdentity(startup, run);
  expect(run).not.toHaveBeenCalled();
  await expect(
    access(
      notificationInstallDirectory(notificationLocationsFromStartup(startup)),
    ),
  ).rejects.toThrow();
});
