import type { BigIntStats } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  NOTIFICATION_OWNER_MARKER,
  type NotificationLocations,
  notificationInstallDirectory,
} from "./notification-locations.js";

export type NotificationDirectoryOwnership = Readonly<{
  directory: string;
  backing: string;
  aliasIdentity: BigIntStats;
  backingIdentity: BigIntStats;
  linkTarget?: string;
}>;

export function renderNotificationLinkOwner(
  directory: string,
  backing: string,
): string {
  return JSON.stringify({
    version: 1,
    alias: resolve(directory),
    backing: basename(backing),
  });
}

async function readNotificationOwnerFile(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error("notification_directory_not_owned");
  if (stat.size > 4096) throw new Error("notification_directory_not_owned");
  return readFile(path, "utf8");
}

async function assertNotificationDirectoryMarker(
  directory: string,
): Promise<void> {
  const marker = await readNotificationOwnerFile(join(directory, ".owner"));
  if (marker !== NOTIFICATION_OWNER_MARKER)
    throw new Error("notification_directory_not_owned");
}

function isNotificationBackingName(directory: string, target: string): boolean {
  if (target !== basename(target)) return false;
  const prefix = basename(directory) + ".data-";
  if (!target.startsWith(prefix)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    target.slice(prefix.length),
  );
}

function hasBoundNotificationLinkOwner(
  value: unknown,
  directory: string,
  target: string,
): boolean {
  if (!value) return false;
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return false;
  if (record.alias !== resolve(directory)) return false;
  return record.backing === target;
}

function hasSameNotificationFileIdentity(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  if (left.dev !== right.dev) return false;
  return left.ino === right.ino;
}

async function readOwnedNotificationPath(
  directory: string,
): Promise<NotificationDirectoryOwnership | undefined> {
  const stat = await lstat(directory, { bigint: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (!stat) return undefined;
  if (stat.isDirectory()) {
    await assertNotificationDirectoryMarker(directory);
    return {
      directory,
      backing: directory,
      aliasIdentity: stat,
      backingIdentity: stat,
    };
  }
  if (!stat.isSymbolicLink())
    throw new Error("notification_directory_not_owned");
  const target = await readlink(directory);
  if (!isNotificationBackingName(directory, target))
    throw new Error("notification_directory_not_owned");
  const backing = join(dirname(directory), target);
  const backingIdentity = await lstat(backing, { bigint: true });
  if (!backingIdentity.isDirectory())
    throw new Error("notification_directory_not_owned");
  await assertNotificationDirectoryMarker(backing);
  const record: unknown = JSON.parse(
    await readNotificationOwnerFile(join(backing, ".owner-link")),
  );
  if (!hasBoundNotificationLinkOwner(record, directory, target))
    throw new Error("notification_directory_not_owned");
  const currentAlias = await lstat(directory, { bigint: true });
  if (!hasSameNotificationFileIdentity(stat, currentAlias))
    throw new Error("notification_directory_changed");
  return {
    directory,
    backing,
    aliasIdentity: stat,
    backingIdentity,
    linkTarget: target,
  };
}

export function readOwnedNotificationDirectory(
  locations: NotificationLocations,
): Promise<NotificationDirectoryOwnership | undefined> {
  return readOwnedNotificationPath(notificationInstallDirectory(locations));
}

export async function assertNotificationOwnershipUnchanged(
  owner: NotificationDirectoryOwnership,
): Promise<void> {
  const current = await readOwnedNotificationPath(owner.directory);
  if (!current) throw new Error("notification_directory_changed");
  if (
    !hasSameNotificationFileIdentity(owner.aliasIdentity, current.aliasIdentity)
  )
    throw new Error("notification_directory_changed");
  if (
    !hasSameNotificationFileIdentity(
      owner.backingIdentity,
      current.backingIdentity,
    )
  )
    throw new Error("notification_directory_changed");
}

export async function assertNotificationBackingUnchanged(
  owner: NotificationDirectoryOwnership,
): Promise<void> {
  const current = await lstat(owner.backing, { bigint: true });
  if (!current.isDirectory()) throw new Error("notification_directory_changed");
  if (!hasSameNotificationFileIdentity(owner.backingIdentity, current))
    throw new Error("notification_directory_changed");
  await assertNotificationDirectoryMarker(owner.backing);
  const record: unknown = JSON.parse(
    await readNotificationOwnerFile(join(owner.backing, ".owner-link")),
  );
  if (
    !hasBoundNotificationLinkOwner(
      record,
      owner.directory,
      basename(owner.backing),
    )
  )
    throw new Error("notification_directory_not_owned");
}
