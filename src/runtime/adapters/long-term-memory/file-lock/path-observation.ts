import { lstat } from "node:fs/promises";
import { fileSystemErrorCode } from "./contracts.js";

/** Only confirmed disappearance can normalize a Windows pending-delete denial. */
export async function observeLockReadFailure(path: string, error: unknown): Promise<unknown> {
  if (!isWindowsLockReadDenial(error)) return error;
  try {
    await lstat(path);
  } catch (observedError) {
    if (fileSystemErrorCode(observedError) === "ENOENT") return observedError;
  }
  return error;
}

export function isWindowsLockReadDenial(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  return fileSystemErrorCode(error) === "EPERM";
}
