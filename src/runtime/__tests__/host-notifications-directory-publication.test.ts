import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  ensureOwnedNotificationDirectory,
  hasOwnedNotificationDirectory,
  removeOwnedNotificationDirectory,
} from "../../computer-access/companion/notification-directory.js";
import {
  notificationInstallDirectory,
  NOTIFICATION_OWNER_MARKER,
  type NotificationLocations,
} from "../../computer-access/companion/notification-locations.js";

const publication = vi.hoisted(() => ({
  destination: "",
  failMarker: false,
  failRemoval: false,
  before: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn<typeof actual.writeFile>(async (path, data, options) => {
      if (publication.failMarker && String(path).endsWith("/.owner-link")) {
        await actual.writeFile(path, String(data).slice(0, 8), options);
        throw new Error("partial link marker");
      }
      return actual.writeFile(path, data, options);
    }),
    rm: vi.fn<typeof actual.rm>(async (path, options) => {
      if (
        publication.failRemoval &&
        String(path).startsWith(publication.destination + ".data-")
      )
        throw new Error("interrupted backing cleanup");
      return actual.rm(path, options);
    }),
    rename: vi.fn<typeof actual.rename>(async (source, destination) => {
      if (destination === publication.destination) await publication.before?.();
      return actual.rename(source, destination);
    }),
    symlink: vi.fn<typeof actual.symlink>(async (source, destination, type) => {
      if (destination === publication.destination) await publication.before?.();
      return actual.symlink(source, destination, type);
    }),
  };
});

const roots: string[] = [];
afterEach(async () => {
  publication.destination = "";
  publication.failMarker = false;
  publication.failRemoval = false;
  publication.before = undefined;
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const artifacts = resolve(
    ".codex/artifacts/notification-publication-review-20260927",
  );
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "publication-"));
  roots.push(root);
  const locations: NotificationLocations = {
    stateDir: join(root, "state"),
    homeDir: root,
  };
  const directory = notificationInstallDirectory(locations);
  publication.destination = directory;
  return { root, locations, directory };
}

test
  .skipIf(process.platform === "win32")
  .each(["directory", "file", "symlink"])(
  "preserves a foreign %s created inside the final publication call",
  async (kind) => {
    const f = await fixture();
    const external = join(f.root, "external");
    await mkdir(external);
    await writeFile(join(external, "keep"), "foreign data");
    let racedIdentity: Awaited<ReturnType<typeof lstat>>;
    publication.before = async () => {
      if (kind === "directory") await mkdir(f.directory);
      if (kind === "file") await writeFile(f.directory, "foreign file");
      if (kind === "symlink") {
        publication.before = undefined;
        await symlink(external, f.directory, "junction");
      }
      racedIdentity = await lstat(f.directory);
    };
    await expect(
      ensureOwnedNotificationDirectory(f.locations),
    ).rejects.toThrow();
    const remaining = await lstat(f.directory);
    expect(remaining.ino).toBe(racedIdentity!.ino);
    expect(remaining.dev).toBe(racedIdentity!.dev);
    if (kind === "directory") expect(await readdir(f.directory)).toEqual([]);
    if (kind === "file")
      expect(await readFile(f.directory, "utf8")).toBe("foreign file");
    expect(await readFile(join(external, "keep"), "utf8")).toBe("foreign data");
    expect(await readdir(dirname(f.directory))).toEqual(["notifications"]);
    await expect(hasOwnedNotificationDirectory(f.locations)).rejects.toThrow();
  },
);

test.skipIf(process.platform === "win32")(
  "a published link retains its complete owned backing and is reusable",
  async () => {
    const f = await fixture();
    await ensureOwnedNotificationDirectory(f.locations);
    const target = await readlink(f.directory);
    const backing = join(dirname(f.directory), target);
    expect(await readFile(join(backing, ".owner"), "utf8")).toBe(
      NOTIFICATION_OWNER_MARKER,
    );
    expect(
      JSON.parse(await readFile(join(backing, ".owner-link"), "utf8")),
    ).toEqual({
      version: 1,
      alias: resolve(f.directory),
      backing: target,
    });
    await ensureOwnedNotificationDirectory(f.locations);
    expect(await readlink(f.directory)).toBe(target);
    expect(await hasOwnedNotificationDirectory(f.locations)).toBe(true);
    await removeOwnedNotificationDirectory(f.locations);
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(backing)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.skipIf(process.platform === "win32")(
  "partial link ownership metadata cannot publish or block a later install",
  async () => {
    const f = await fixture();
    publication.failMarker = true;
    await expect(ensureOwnedNotificationDirectory(f.locations)).rejects.toThrow(
      "partial link marker",
    );
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(dirname(f.directory))).toEqual([]);
    publication.failMarker = false;
    await ensureOwnedNotificationDirectory(f.locations);
    await removeOwnedNotificationDirectory(f.locations);
    expect(await readdir(dirname(f.directory))).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "interrupted uninstall leaves an unreferenced backing and permits fresh installation",
  async () => {
    const f = await fixture();
    await ensureOwnedNotificationDirectory(f.locations);
    const oldTarget = await readlink(f.directory);
    const oldBacking = join(dirname(f.directory), oldTarget);
    publication.failRemoval = true;
    await expect(removeOwnedNotificationDirectory(f.locations)).rejects.toThrow(
      "interrupted backing cleanup",
    );
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(oldBacking, ".owner"), "utf8")).toBe(
      NOTIFICATION_OWNER_MARKER,
    );
    publication.failRemoval = false;
    await ensureOwnedNotificationDirectory(f.locations);
    expect(await readlink(f.directory)).not.toBe(oldTarget);
    await removeOwnedNotificationDirectory(f.locations);
    expect(await readdir(dirname(f.directory))).toEqual([oldTarget]);
  },
);

test("existing plain owned directories keep their legacy behavior", async () => {
  const f = await fixture();
  await mkdir(f.directory, { recursive: true });
  await writeFile(join(f.directory, ".owner"), NOTIFICATION_OWNER_MARKER);
  await writeFile(join(f.directory, "pending-message"), "retained");
  await ensureOwnedNotificationDirectory(f.locations);
  expect((await lstat(f.directory)).isDirectory()).toBe(true);
  expect(await readFile(join(f.directory, "pending-message"), "utf8")).toBe(
    "retained",
  );
  await removeOwnedNotificationDirectory(f.locations);
  await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
});

test
  .skipIf(process.platform === "win32")
  .each([
    "unbound",
    "wrong-alias",
    "wrong-backing",
    "traversal",
    "absolute",
    "dangling",
    "chain",
    "marker-link",
    "owner-link",
  ])(
  "rejects %s links and preserves their data on install and uninstall",
  async (kind) => {
    const f = await fixture();
    await mkdir(dirname(f.directory), { recursive: true });
    const target = "notifications.data-11111111-1111-4111-8111-111111111111";
    const backing = join(dirname(f.directory), target);
    const external = join(f.root, "external");
    await mkdir(external);
    await writeFile(join(external, "keep"), "foreign data");
    if (kind !== "dangling" && kind !== "chain") await mkdir(backing);
    if (kind === "chain") await symlink(external, backing, "dir");
    if (kind !== "dangling") {
      await writeFile(join(backing, ".owner"), NOTIFICATION_OWNER_MARKER);
      const record = JSON.stringify({
        version: 1,
        alias:
          kind === "wrong-alias" ? join(f.root, "other") : resolve(f.directory),
        backing: kind === "wrong-backing" ? "other" : target,
      });
      if (kind !== "unbound")
        await writeFile(join(backing, ".owner-link"), record);
      if (kind === "marker-link") {
        await writeFile(join(external, "record"), record);
        await rm(join(backing, ".owner-link"));
        await symlink(join(external, "record"), join(backing, ".owner-link"));
      }
      if (kind === "owner-link") {
        await writeFile(join(external, "owner"), NOTIFICATION_OWNER_MARKER);
        await rm(join(backing, ".owner"));
        await symlink(join(external, "owner"), join(backing, ".owner"));
      }
    }
    let linkTarget = target;
    if (kind === "traversal") linkTarget = "../external";
    if (kind === "absolute") linkTarget = backing;
    await symlink(linkTarget, f.directory, "dir");
    await expect(
      ensureOwnedNotificationDirectory(f.locations),
    ).rejects.toThrow();
    await expect(
      removeOwnedNotificationDirectory(f.locations),
    ).rejects.toThrow();
    expect(await readlink(f.directory)).toBe(linkTarget);
    expect(await readFile(join(external, "keep"), "utf8")).toBe("foreign data");
  },
);
