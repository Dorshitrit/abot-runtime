import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  directorySnapshot,
  fileSystemErrorCode,
  LEASE_DIRECTORY_NAME,
  OWNER_FILE_PATTERN,
  type DirectoryLockSnapshot,
  type LockSnapshot,
} from "./contracts.js";
import { readOwnerRecord } from "./owner-record.js";

export async function readLockSnapshot(
  lockPath: string,
): Promise<LockSnapshot | undefined> {
  const lockInfo = await readLockInfo(lockPath);
  if (!lockInfo) return undefined;
  if (!lockInfo.isDirectory()) {
    return Object.freeze({ kind: "legacy_file" as const });
  }

  let lockEntries;
  try {
    lockEntries = await readdir(lockPath, { withFileTypes: true });
  } catch (error) {
    const code = fileSystemErrorCode(error);
    if (code === "ENOENT") return undefined;
    if (code === "ENOTDIR") {
      return Object.freeze({ kind: "legacy_file" as const });
    }
    throw error;
  }
  if (lockEntries.length === 0) {
    return directorySnapshot({
      modifiedAtMs: lockInfo.mtimeMs,
      hasLeaseDirectory: false,
      reclaimable: true,
    });
  }
  const hasExpectedLeaseDirectory =
    lockEntries.length === 1 &&
    lockEntries[0]?.name === LEASE_DIRECTORY_NAME &&
    lockEntries[0].isDirectory();
  if (!hasExpectedLeaseDirectory) {
    return directorySnapshot({
      modifiedAtMs: lockInfo.mtimeMs,
      hasLeaseDirectory: false,
      reclaimable: false,
    });
  }
  return readLeaseSnapshot(lockPath, lockInfo.mtimeMs);
}

async function readLockInfo(lockPath: string) {
  try {
    return await lstat(lockPath);
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function readLeaseSnapshot(
  lockPath: string,
  lockModifiedAtMs: number,
): Promise<DirectoryLockSnapshot> {
  const leasePath = join(lockPath, LEASE_DIRECTORY_NAME);
  let leaseInfo;
  let leaseEntries;
  try {
    leaseInfo = await lstat(leasePath);
    if (!leaseInfo.isDirectory()) {
      return invalidLeaseSnapshot(lockModifiedAtMs);
    }
    leaseEntries = await readdir(leasePath, { withFileTypes: true });
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") {
      return invalidLeaseSnapshot(lockModifiedAtMs);
    }
    throw error;
  }
  const modifiedAtMs = Math.max(lockModifiedAtMs, leaseInfo.mtimeMs);
  if (leaseEntries.length === 0) {
    return directorySnapshot({
      modifiedAtMs,
      hasLeaseDirectory: true,
      reclaimable: true,
    });
  }
  if (leaseEntries.length !== 1 || !leaseEntries[0]?.isFile()) {
    return directorySnapshot({
      modifiedAtMs,
      hasLeaseDirectory: true,
      reclaimable: false,
    });
  }

  const entryName = leaseEntries[0].name;
  const token = OWNER_FILE_PATTERN.exec(entryName)?.[1];
  if (!token) {
    return directorySnapshot({
      modifiedAtMs,
      hasLeaseDirectory: true,
      reclaimable: false,
    });
  }
  return readOwnerRecord(lockPath, entryName, token, modifiedAtMs);
}

function invalidLeaseSnapshot(modifiedAtMs: number): DirectoryLockSnapshot {
  return directorySnapshot({
    modifiedAtMs,
    hasLeaseDirectory: false,
    reclaimable: false,
  });
}
