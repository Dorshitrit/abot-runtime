import {
  access,
  mkdir,
  mkdtemp,
  lstat,
  readlink,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { NativeAutostartOptions } from "../../computer-access/companion/autostart.js";
import {
  installDesktopNotificationIdentity,
  uninstallDesktopNotificationIdentity,
  hasOwnedNotificationDirectory,
  notificationLocationsFromStartup,
} from "../../computer-access/companion/notification-installation.js";
import {
  notificationInstallDirectory,
  NOTIFICATION_OWNER_MARKER,
} from "../../computer-access/companion/notification-locations.js";
import type { NotificationProcessRunner } from "../../computer-access/companion/notification-process.js";
import { withWindowsNotificationDirectoryPublication } from "./support/notification-directory-publication.js";

const fault = vi.hoisted(() => ({
  kind: "",
  directory: "",
  beforeRename: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn<typeof actual.writeFile>(async (path, data, options) => {
      if (fault.kind === "partial" && basename(String(path)) === ".owner") {
        await actual.writeFile(path, String(data).slice(0, 8), options);
        throw new Error("injected partial owner write");
      }
      await actual.writeFile(path, data, options);
      if (
        fault.kind === "foreign-during-write" &&
        basename(String(path)) === ".owner"
      )
        await actual.mkdir(fault.directory);
    }),
    symlink: vi.fn<typeof actual.symlink>(async (target, path, type) => {
      if (fault.kind === "rename" && path === fault.directory)
        throw new Error("injected owner directory rename failure");
      if (path === fault.directory) await fault.beforeRename?.();
      return actual.symlink(target, path, type);
    }),
    rename: vi.fn<typeof actual.rename>(async (oldPath, newPath) => {
      if (fault.kind === "rename" && newPath === fault.directory)
        throw new Error("injected owner directory rename failure");
      if (newPath === fault.directory) await fault.beforeRename?.();
      return actual.rename(oldPath, newPath);
    }),
  };
});

const directories: string[] = [];
afterEach(async () => {
  fault.kind = "";
  fault.directory = "";
  fault.beforeRename = undefined;
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const artifacts = resolve(
    ".codex/artifacts/notification-publication-review-20260927",
  );
  await mkdir(artifacts, { recursive: true });
  const homeDir = await mkdtemp(join(artifacts, "initial-owner-"));
  directories.push(homeDir);
  const startup: NativeAutostartOptions = {
    platform: "win32",
    homeDir,
    stateDir: join(homeDir, "state"),
    nodePath: "/fixture/node",
    cliPath: "/fixture/companion.mjs",
    appData: join(homeDir, "appdata"),
  };
  const locations = notificationLocationsFromStartup(startup);
  const directory = notificationInstallDirectory(locations);
  fault.directory = directory;
  const run = vi.fn<NotificationProcessRunner>(async () => "");
  const execute = withWindowsNotificationDirectoryPublication(
    run,
    homeDir,
    async () => {
      if (fault.kind === "rename")
        throw new Error("injected owner directory rename failure");
      await fault.beforeRename?.();
    },
  );
  return { startup, directory, locations, run, execute };
}

test.each(["partial", "rename"])(
  "%s failure leaves initial registration absent and permits later install and uninstall",
  async (failure) => {
    const f = await fixture();
    fault.kind = failure;
    await expect(
      installDesktopNotificationIdentity(
        f.startup,
        "ws://abot.localhost:5199",
        f.execute,
      ),
    ).rejects.toThrow(
      failure === "partial"
        ? "partial owner write"
        : "owner directory rename failure",
    );
    await expect(access(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(dirname(f.directory))).toEqual([]);
    expect(f.run).not.toHaveBeenCalled();
    await uninstallDesktopNotificationIdentity(f.startup, f.execute);
    fault.kind = "";
    await installDesktopNotificationIdentity(
      f.startup,
      "ws://abot.localhost:5199",
      f.execute,
    );
    expect(await hasOwnedNotificationDirectory(f.locations)).toBe(true);
    expect(await readFile(join(f.directory, ".owner"), "utf8")).toBe(
      NOTIFICATION_OWNER_MARKER,
    );
    await uninstallDesktopNotificationIdentity(f.startup, f.execute);
    await expect(access(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each(["empty", "foreign", "symlink"])(
  "refuses an existing %s destination without changing its contents",
  async (kind) => {
    const f = await fixture();
    const foreign = join(f.startup.homeDir, "foreign");
    await mkdir(foreign);
    await writeFile(join(foreign, ".owner"), NOTIFICATION_OWNER_MARKER);
    await writeFile(join(foreign, "keep"), "foreign data");
    await mkdir(dirname(f.directory), { recursive: true });
    if (kind === "symlink") await symlink(foreign, f.directory, "junction");
    if (kind !== "symlink") await mkdir(f.directory);
    if (kind === "foreign")
      await writeFile(join(f.directory, "keep"), "user data");
    await expect(
      installDesktopNotificationIdentity(
        f.startup,
        "ws://abot.localhost:5199",
        f.execute,
      ),
    ).rejects.toThrow();
    await expect(
      uninstallDesktopNotificationIdentity(f.startup, f.execute),
    ).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    expect(await readFile(join(foreign, "keep"), "utf8")).toBe("foreign data");
    if (kind === "foreign")
      expect(await readFile(join(f.directory, "keep"), "utf8")).toBe(
        "user data",
      );
    if (kind === "empty") expect(await readdir(f.directory)).toEqual([]);
    expect(await readdir(dirname(f.directory))).toEqual([
      basename(f.directory),
    ]);
  },
);

test("concurrent first installs reuse only the verified owned winner", async () => {
  const f = await fixture();
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  fault.beforeRename = async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await barrier;
  };
  await Promise.all([
    installDesktopNotificationIdentity(
      f.startup,
      "ws://abot.localhost:5199",
      f.execute,
    ),
    installDesktopNotificationIdentity(
      f.startup,
      "ws://abot.localhost:5199",
      f.execute,
    ),
  ]);
  expect(arrivals).toBe(2);
  expect(await hasOwnedNotificationDirectory(f.locations)).toBe(true);
  expect(await readFile(join(f.directory, ".owner"), "utf8")).toBe(
    NOTIFICATION_OWNER_MARKER,
  );
  const identity = await lstat(f.directory);
  const expectedEntries = [basename(f.directory)];
  if (identity.isSymbolicLink())
    expectedEntries.push(await readlink(f.directory));
  expect((await readdir(dirname(f.directory))).sort()).toEqual(
    expectedEntries.sort(),
  );
  expect(f.run).toHaveBeenCalledTimes(2);
  await uninstallDesktopNotificationIdentity(f.startup, f.execute);
  await expect(access(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("an unrelated empty directory appearing during staging is preserved", async () => {
  const f = await fixture();
  fault.kind = "foreign-during-write";
  await expect(
    installDesktopNotificationIdentity(
      f.startup,
      "ws://abot.localhost:5199",
      f.execute,
    ),
  ).rejects.toThrow();
  expect(await readdir(f.directory)).toEqual([]);
  expect(await readdir(dirname(f.directory))).toEqual([basename(f.directory)]);
  expect(f.run).not.toHaveBeenCalled();
});

test("an abandoned private staging directory does not block a fresh install or become cleanup authority", async () => {
  const f = await fixture();
  const abandoned = f.directory + ".install-abandoned";
  await mkdir(abandoned, { recursive: true });
  await writeFile(join(abandoned, ".owner"), "partial");
  await installDesktopNotificationIdentity(
    f.startup,
    "ws://abot.localhost:5199",
    f.execute,
  );
  expect(await hasOwnedNotificationDirectory(f.locations)).toBe(true);
  await uninstallDesktopNotificationIdentity(f.startup, f.execute);
  await expect(access(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(abandoned, ".owner"), "utf8")).toBe("partial");
});
