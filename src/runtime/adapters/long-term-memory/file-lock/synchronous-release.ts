import { rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileSystemErrorCode, LEASE_DIRECTORY_NAME } from "./contracts.js";

/** Keep token removal and directory cleanup indivisible by JavaScript exit. */
export function removeObservedOwnerSynchronously(
  lockPath: string,
  observedOwnerFileName: string,
): boolean {
  try {
    unlinkSync(join(lockPath, LEASE_DIRECTORY_NAME, observedOwnerFileName));
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (!removeReleasedDirectory(join(lockPath, LEASE_DIRECTORY_NAME)))
    return false;
  return removeReleasedDirectory(lockPath);
}

function removeReleasedDirectory(path: string): boolean {
  try {
    rmdirSync(path);
    return true;
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return true;
    if (hasReplacementDirectoryContent(error)) return false;
    throw error;
  }
}

function hasReplacementDirectoryContent(error: unknown): boolean {
  switch (fileSystemErrorCode(error)) {
    case "EEXIST":
    case "ENOTEMPTY":
    case "ENOTDIR":
      return true;
    default:
      return false;
  }
}
