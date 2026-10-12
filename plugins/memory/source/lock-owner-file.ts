import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

import {
  isWindowsLockObservationDenial,
  rethrowLockObservationError,
} from "./lock-path-observation.js";

function lockOwnerOpenError(code: "ELOOP" | "EAGAIN"): Error {
  return Object.assign(new Error("Memory lock owner is not a stable regular file."), {
    code,
  });
}

function hasSameRegularOwnerIdentity(
  before: BigIntStats,
  current: BigIntStats,
): boolean {
  if (!current.isFile()) return false;
  if (current.dev !== before.dev) return false;
  return current.ino === before.ino;
}

async function openObservedLockOwner(
  path: string,
  flags: number,
  before: BigIntStats,
): Promise<FileHandle> {
  try {
    return await open(path, flags);
  } catch (error) {
    if (!isWindowsLockObservationDenial(error)) throw error;
    // Windows can report a pending deletion as EPERM. Only a fresh name
    // observation may classify it as a vanished or replaced owner.
    const named = await lstat(path, { bigint: true });
    if (!hasSameRegularOwnerIdentity(before, named)) {
      throw lockOwnerOpenError("EAGAIN");
    }
    throw error;
  }
}

/**
 * Preserve atomic no-follow where Node supports it. On Windows, verify the
 * named regular file and opened handle before accepting any owner record.
 * This guards lock ownership; it is not a general filesystem sandbox.
 */
export async function openLockOwnerFile(path: string): Promise<FileHandle> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile()) throw lockOwnerOpenError("ELOOP");
  const noFollow = constants.O_NOFOLLOW;
  const flags = typeof noFollow === "number"
    ? constants.O_RDONLY | noFollow
    : constants.O_RDONLY;
  const handle = await openObservedLockOwner(path, flags, before);
  try {
    const opened = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (!hasSameRegularOwnerIdentity(before, opened)) {
      throw lockOwnerOpenError("EAGAIN");
    }
    if (!hasSameRegularOwnerIdentity(before, named)) {
      throw lockOwnerOpenError("EAGAIN");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    // Closing our handle can complete a Windows pending deletion.
    return rethrowLockObservationError(path, error);
  }
}
