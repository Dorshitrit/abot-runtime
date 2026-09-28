import { randomUUID } from "node:crypto";
import { mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  NOTIFICATION_OWNER_MARKER,
  notificationInstallDirectory,
  type NotificationLocations,
} from "./notification-locations.js";
import {
  assertNotificationBackingUnchanged,
  assertNotificationOwnershipUnchanged,
  readOwnedNotificationDirectory,
  renderNotificationLinkOwner,
} from "./notification-directory-ownership.js";
import { publishWindowsNotificationDirectory } from "./notification-directory-windows.js";
import {
  runNotificationProcess,
  type NotificationProcessRunner,
} from "./notification-process.js";

function requiresNotificationDirectoryLink(): boolean {
  return process.platform !== "win32";
}

export async function hasOwnedNotificationDirectory(
  locations: NotificationLocations,
): Promise<boolean> {
  return Boolean(await readOwnedNotificationDirectory(locations));
}

async function publishOwnedNotificationDirectory(
  staged: string,
  locations: NotificationLocations,
  run: NotificationProcessRunner,
): Promise<boolean> {
  if (await hasOwnedNotificationDirectory(locations)) return false;
  const directory = notificationInstallDirectory(locations);
  try {
    if (!requiresNotificationDirectoryLink()) {
      await publishWindowsNotificationDirectory(staged, directory, run);
      return false;
    }
    await symlink(basename(staged), directory, "dir");
    return true;
  } catch (error) {
    if (await hasOwnedNotificationDirectory(locations)) return false;
    throw error;
  }
}

export async function ensureOwnedNotificationDirectory(
  locations: NotificationLocations,
  run: NotificationProcessRunner = runNotificationProcess,
): Promise<void> {
  if (await hasOwnedNotificationDirectory(locations)) return;
  const directory = notificationInstallDirectory(locations);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const staged = directory + ".data-" + randomUUID();
  await mkdir(staged, { mode: 0o700 });
  let retainBacking = false;
  try {
    await writeFile(join(staged, ".owner"), NOTIFICATION_OWNER_MARKER, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    if (requiresNotificationDirectoryLink()) {
      await writeFile(
        join(staged, ".owner-link"),
        renderNotificationLinkOwner(directory, staged),
        {
          flag: "wx",
          mode: 0o600,
          flush: true,
        },
      );
    }
    retainBacking = await publishOwnedNotificationDirectory(
      staged,
      locations,
      run,
    );
  } finally {
    if (!retainBacking) await rm(staged, { recursive: true, force: true });
  }
}

export async function removeOwnedNotificationDirectory(
  locations: NotificationLocations,
): Promise<void> {
  const owner = await readOwnedNotificationDirectory(locations);
  if (!owner) return;
  await assertNotificationOwnershipUnchanged(owner);
  if (owner.linkTarget === undefined) {
    await rm(owner.directory, { recursive: true });
    return;
  }
  await unlink(owner.directory);
  await assertNotificationBackingUnchanged(owner);
  await rm(owner.backing, { recursive: true });
}
