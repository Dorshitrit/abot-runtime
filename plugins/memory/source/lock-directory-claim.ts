import type { BigIntStats } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";

import { isWindowsLockObservationDenial } from "./lock-path-observation.js";

type LockClaimObservation = Readonly<{
  observed: boolean;
  entry?: BigIntStats;
}>;

function isAbsentLockClaimEntry(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ENOENT";
}

async function observeLockClaimPath(path: string): Promise<LockClaimObservation> {
  try {
    return { observed: true, entry: await lstat(path, { bigint: true }) };
  } catch (error) {
    return { observed: isAbsentLockClaimEntry(error) };
  }
}

function hasObservedLockNameTransition(
  before: LockClaimObservation,
  after: LockClaimObservation,
): boolean {
  if (!before.observed || !after.observed) return false;
  if (!before.entry) return after.entry !== undefined;
  if (!after.entry) return true;
  if (before.entry.dev !== after.entry.dev) return true;
  if (before.entry.ino !== after.entry.ino) return true;
  if (before.entry.isDirectory() !== after.entry.isDirectory()) return true;
  if (before.entry.isFile() !== after.entry.isFile()) return true;
  return before.entry.isSymbolicLink() !== after.entry.isSymbolicLink();
}

/** Successful mkdir alone grants ownership; a proven name race is contention. */
export async function claimStoreLockDirectory(path: string): Promise<void> {
  if (process.platform !== "win32") {
    await mkdir(path, { mode: 0o700 });
    return;
  }
  const before = await observeLockClaimPath(path);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isWindowsLockObservationDenial(error)) throw error;
    const after = await observeLockClaimPath(path);
    if (!hasObservedLockNameTransition(before, after)) throw error;
    throw Object.assign(new Error("Memory lock name changed during its directory claim."), {
      code: "EEXIST",
      cause: error,
    });
  }
}
