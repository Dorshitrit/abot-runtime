import { rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { fileSystemErrorCode, LEASE_DIRECTORY_NAME } from "./contracts.js";

export async function removeObservedOwner(
  lockPath: string,
  observedOwnerFileName: string,
): Promise<boolean> {
  try {
    await unlink(join(lockPath, LEASE_DIRECTORY_NAME, observedOwnerFileName));
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  return removeEmptyLockTree(lockPath, true);
}

export async function removeEmptyLockTree(
  lockPath: string,
  hasLeaseDirectory: boolean,
): Promise<boolean> {
  if (
    hasLeaseDirectory &&
    !(await removeDirectoryIfEmpty(join(lockPath, LEASE_DIRECTORY_NAME)))
  ) {
    return false;
  }
  return removeDirectoryIfEmpty(lockPath);
}

export async function removeDirectoryIfEmpty(path: string): Promise<boolean> {
  try {
    await rmdir(path);
    return true;
  } catch (error) {
    const code = fileSystemErrorCode(error);
    if (code === "ENOENT") return true;
    if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

export async function removeStagingLock(
  stagingPath: string,
  stagingOwnerPath: string,
): Promise<void> {
  try {
    await unlink(stagingOwnerPath);
  } catch (error) {
    if (fileSystemErrorCode(error) !== "ENOENT") throw error;
  }
  try {
    await rmdir(stagingPath);
  } catch (error) {
    if (fileSystemErrorCode(error) !== "ENOENT") throw error;
  }
}
