import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { assertMacNotificationBundle, configureMacNotificationBundle } from "../../computer-access/companion/notification-macos-bundle.js";
import { installDesktopNotificationIdentity, notificationLocationsFromStartup } from "../../computer-access/companion/notification-installation.js";
import { hasDesktopNotificationSupport } from "../../computer-access/companion/notification-readiness.js";
import { notificationInstallDirectory } from "../../computer-access/companion/notification-locations.js";
import type { NotificationProcessRunner } from "../../computer-access/companion/notification-process.js";
import { createCompiledMacNotificationFixture, runMacNotificationPlistFixture } from "./support/mac-notification-bundle.js";
import { withWindowsNotificationDirectoryPublication } from "./support/notification-directory-publication.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const artifacts = resolve(".codex/artifacts/macos-qa-20261001");
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "mac-bundle-"));
  directories.push(directory);
  const app = join(directory, "ABot.app");
  await createCompiledMacNotificationFixture(app, "droplet");
  const run = vi.fn<NotificationProcessRunner>(async (input) => runMacNotificationPlistFixture(input) ?? "");
  return { directory, app, run, plist: join(app, "Contents", "Info.plist"), binary: join(app, "Contents", "MacOS", "droplet") };
}

test.each(["applet", "droplet"])("configuration preserves compiler-owned %s metadata and executable", async (executable) => {
  const f = await fixture();
  await createCompiledMacNotificationFixture(f.app, executable);
  const before = JSON.parse(await readFile(f.plist, "utf8"));
  await configureMacNotificationBundle(f.app, f.run);
  await assertMacNotificationBundle(f.app, f.run);
  const after = JSON.parse(await readFile(f.plist, "utf8"));
  expect(after).toEqual({ ...before, CFBundleIdentifier: "com.abot.notifications", CFBundleName: "ABot", CFBundleDisplayName: "ABot",
    LSUIElement: true, OSAAppletStayOpen: true, OSAAppletShowStartupScreen: false, NSHighResolutionCapable: true });
  expect(f.run.mock.calls.every(([input]) => input.file === "/usr/bin/osascript")).toBe(true);
});

test.each(["applet", "../droplet", "/tmp/droplet", "sub/droplet", "sub\\droplet", ".", "..", "", "droplet\n"])("rejects missing or unsafe executable %j without replacing the compiler plist", async (executable) => {
  const f = await fixture();
  const metadata = JSON.parse(await readFile(f.plist, "utf8"));
  metadata.CFBundleExecutable = executable;
  const before = JSON.stringify(metadata);
  await writeFile(f.plist, before);
  await expect(configureMacNotificationBundle(f.app, f.run)).rejects.toThrow();
  expect(await readFile(f.plist, "utf8")).toBe(before);
});

test.skipIf(process.platform === "win32")("rejects symlink executables and non-executable files", async () => {
  const f = await fixture();
  await chmod(f.binary, 0o644);
  await expect(configureMacNotificationBundle(f.app, f.run)).rejects.toThrow();
  await rm(f.binary);
  const target = join(f.directory, "outside");
  await writeFile(target, "fixture", { mode: 0o755 });
  await symlink(target, f.binary);
  await expect(configureMacNotificationBundle(f.app, f.run)).rejects.toThrow("notification_bundle_file_invalid");
});

test.skipIf(process.platform === "win32")("rejects symlink bundle directories and plist files", async () => {
  const f = await fixture();
  const alias = join(f.directory, "Alias.app");
  await symlink(f.app, alias, "dir");
  await expect(configureMacNotificationBundle(alias, f.run)).rejects.toThrow("notification_bundle_directory_invalid");
  const metadata = await readFile(f.plist, "utf8");
  await rm(f.plist);
  const target = join(f.directory, "outside.plist");
  await writeFile(target, metadata);
  await symlink(target, f.plist);
  await expect(configureMacNotificationBundle(f.app, f.run)).rejects.toThrow("notification_bundle_file_invalid");
});

test("failed compiled bundle validation cannot publish a ready receipt or register the app", async () => {
  const f = await fixture();
  const startup = { platform: "darwin" as const, homeDir: f.directory, stateDir: join(f.directory, "state"), nodePath: "/fixture/node", cliPath: "/fixture/companion.mjs" };
  const run = vi.fn<NotificationProcessRunner>(async (input) => {
    if (input.file === "/usr/bin/osacompile") {
      const app = input.args[input.args.indexOf("-o") + 1]!;
      await createCompiledMacNotificationFixture(app, "droplet");
      await rm(join(app, "Contents", "MacOS", "droplet"));
    }
    return runMacNotificationPlistFixture(input) ?? "";
  });
  await expect(installDesktopNotificationIdentity(startup, "ws://abot.localhost:5199",
    withWindowsNotificationDirectoryPublication(run, startup.homeDir))).rejects.toThrow();
  const locations = notificationLocationsFromStartup(startup);
  await expect(readFile(join(notificationInstallDirectory(locations), ".ready"))).rejects.toThrow();
  expect(await hasDesktopNotificationSupport("macos", locations, run)).toBe(false);
  expect(run.mock.calls.some(([input]) => input.file.endsWith("/codesign") || input.file.endsWith("/lsregister"))).toBe(false);
});

test("readiness validates the declared identity and forwards cancellation to its native metadata probe", async () => {
  const f = await fixture();
  await expect(assertMacNotificationBundle(f.app, f.run)).rejects.toThrow("notification_bundle_identity_invalid");
  await configureMacNotificationBundle(f.app, f.run);
  const controller = new AbortController();
  await assertMacNotificationBundle(f.app, f.run, controller.signal);
  expect(f.run.mock.calls.at(-1)![0].signal).toBe(controller.signal);
});
