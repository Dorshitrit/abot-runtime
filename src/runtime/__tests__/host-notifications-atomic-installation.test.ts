import {
  access,
  mkdir,
  mkdtemp,
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
  linuxNotificationDesktopPath,
  notificationLocationsFromStartup,
  renderLinuxNotificationDesktop,
} from "../../computer-access/companion/notification-installation.js";
import type { NotificationProcessRunner } from "../../computer-access/companion/notification-process.js";
import { withWindowsNotificationDirectoryPublication } from "./support/notification-directory-publication.js";

const fault = vi.hoisted(() => ({ kind: "", desktop: "", temporary: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn<typeof actual.writeFile>(async (path, data, options) => {
      if (fault.kind === "partial" && path === fault.desktop) {
        await actual.writeFile(path, String(data).slice(0, 8), options);
        throw new Error("injected partial desktop write");
      }
      return actual.writeFile(path, data, options);
    }),
    open: vi.fn<typeof actual.open>(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode);
      if (!String(path).startsWith(fault.desktop + ".")) return handle;
      fault.temporary = String(path);
      if (!["partial", "replace-owner"].includes(fault.kind)) return handle;
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(
        async (data, options) => {
          if (fault.kind === "partial") {
            await write(String(data).slice(0, 8), options);
            throw new Error("injected partial desktop write");
          }
          await write(data, options);
          await actual.writeFile(fault.desktop, "new unrelated owner");
        },
      );
      return handle;
    }),
    rename: vi.fn<typeof actual.rename>(async (oldPath, newPath) => {
      if (fault.kind === "rename" && newPath === fault.desktop)
        throw new Error("injected desktop rename failure");
      return actual.rename(oldPath, newPath);
    }),
  };
});

const directories: string[] = [];
afterEach(async () => {
  fault.kind = "";
  fault.desktop = "";
  fault.temporary = "";
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const artifacts = resolve(
    ".codex/artifacts/notification-linux-review-20260927",
  );
  await mkdir(artifacts, { recursive: true });
  const homeDir = await mkdtemp(join(artifacts, "atomic-install-"));
  directories.push(homeDir);
  vi.stubEnv("XDG_DATA_HOME", join(homeDir, "data"));
  const startup: NativeAutostartOptions = {
    platform: "linux",
    homeDir,
    stateDir: join(homeDir, "state"),
    nodePath: "/fixture/node",
    cliPath: "/fixture/companion.mjs",
  };
  const desktop = linuxNotificationDesktopPath(
    notificationLocationsFromStartup(startup),
  );
  fault.desktop = desktop;
  const run = vi.fn<NotificationProcessRunner>(
    async () => "--wait --action --print-id",
  );
  return {
    startup,
    desktop,
    run: withWindowsNotificationDirectoryPublication(run, homeDir),
  };
}

test("initial Linux registration commits complete content and leaves no temporary file", async () => {
  const f = await fixture();
  await installDesktopNotificationIdentity(
    f.startup,
    "ws://abot.localhost:5199",
    f.run,
  );
  expect(await readFile(f.desktop, "utf8")).toBe(
    renderLinuxNotificationDesktop("ws://abot.localhost:5199"),
  );
  expect(await readdir(dirname(f.desktop))).toEqual([basename(f.desktop)]);
  await uninstallDesktopNotificationIdentity(f.startup, f.run);
  await expect(access(f.desktop)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["partial", "rename"])(
  "%s failure preserves the owned registration and allows reinstall and uninstall",
  async (failure) => {
    const f = await fixture();
    const previous = renderLinuxNotificationDesktop("ws://abot.localhost:5199");
    await installDesktopNotificationIdentity(
      f.startup,
      "ws://abot.localhost:5199",
      f.run,
    );
    fault.kind = failure;
    await expect(
      installDesktopNotificationIdentity(
        f.startup,
        "ws://abot.localhost:5299",
        f.run,
      ),
    ).rejects.toThrow(
      failure === "partial"
        ? "partial desktop write"
        : "desktop rename failure",
    );
    expect(await readFile(f.desktop, "utf8")).toBe(previous);
    expect(await readdir(dirname(f.desktop))).toEqual([basename(f.desktop)]);
    await expect(access(fault.temporary)).rejects.toMatchObject({
      code: "ENOENT",
    });
    fault.kind = "";
    await installDesktopNotificationIdentity(
      f.startup,
      "ws://abot.localhost:5299",
      f.run,
    );
    expect(await readFile(f.desktop, "utf8")).toBe(
      renderLinuxNotificationDesktop("ws://abot.localhost:5299"),
    );
    await uninstallDesktopNotificationIdentity(f.startup, f.run);
    await expect(access(f.desktop)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each(["unowned", "symlink"])(
  "an existing %s desktop entry is preserved",
  async (entry) => {
    const f = await fixture();
    await mkdir(dirname(f.desktop), { recursive: true });
    const unrelated = join(f.startup.homeDir, "keep.desktop");
    await writeFile(unrelated, "unrelated content");
    if (entry === "unowned") await writeFile(f.desktop, "unrelated content");
    if (entry === "symlink") await symlink(unrelated, f.desktop);
    await expect(
      installDesktopNotificationIdentity(
        f.startup,
        "ws://abot.localhost:5199",
        f.run,
      ),
    ).rejects.toThrow("notification_registration_not_owned");
    expect(await readFile(f.desktop, "utf8")).toBe("unrelated content");
    expect(await readFile(unrelated, "utf8")).toBe("unrelated content");
    expect(await readdir(dirname(f.desktop))).toEqual([basename(f.desktop)]);
  },
);

test("an ownership change during staging blocks replacement and cleans the owned temporary file", async () => {
  const f = await fixture();
  await installDesktopNotificationIdentity(
    f.startup,
    "ws://abot.localhost:5199",
    f.run,
  );
  fault.kind = "replace-owner";
  await expect(
    installDesktopNotificationIdentity(
      f.startup,
      "ws://abot.localhost:5299",
      f.run,
    ),
  ).rejects.toThrow("notification_registration_not_owned");
  expect(await readFile(f.desktop, "utf8")).toBe("new unrelated owner");
  expect(await readdir(dirname(f.desktop))).toEqual([basename(f.desktop)]);
});
