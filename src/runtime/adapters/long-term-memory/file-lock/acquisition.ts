import { randomUUID } from "node:crypto";

import { removeEmptyLockTree, removeObservedOwner } from "./cleanup.js";
import {
  fileSystemErrorCode,
  INCOMPLETE_LOCK_GRACE_MS,
  LOCK_ACQUIRE_TIMEOUT_MS,
  LOCK_RETRY_DELAY_MS,
  ownerFileName,
  type FileLockOptions,
} from "./contracts.js";
import { installLockDirectory } from "./install.js";
import { readLockSnapshot } from "./snapshot.js";
import { removeObservedOwnerSynchronously } from "./synchronous-release.js";

export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions,
): Promise<() => Promise<void>> {
  const waitMs = options.waitMs ?? LOCK_ACQUIRE_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? LOCK_RETRY_DELAY_MS;
  const processIsAlive = options.processIsAlive ?? defaultProcessIsAlive;
  const deadline = Date.now() + waitMs;

  for (;;) {
    const token = randomUUID();
    try {
      await installLockDirectory(lockPath, token);
      return createRelease(lockPath, token, options.releaseMode);
    } catch (error) {
      if (!isLockContention(error)) throw error;
      const removed = await removeAbandonedLock(lockPath, processIsAlive);
      if (removed) continue;
      if (Date.now() >= deadline) {
        throw new Error("long_term_memory_store_lock_timeout");
      }
      await delay(Math.min(retryDelayMs, Math.max(deadline - Date.now(), 0)));
    }
  }
}

function createRelease(
  lockPath: string,
  token: string,
  releaseMode: FileLockOptions["releaseMode"],
): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) return;
    if (requiresSynchronousRelease(releaseMode)) {
      removeObservedOwnerSynchronously(lockPath, ownerFileName(token));
      released = true;
      return;
    }
    await removeObservedOwner(lockPath, ownerFileName(token));
    released = true;
  };
}

function requiresSynchronousRelease(
  mode: FileLockOptions["releaseMode"],
): boolean {
  return mode === "synchronous";
}

async function removeAbandonedLock(
  lockPath: string,
  processIsAlive: (pid: number) => boolean,
): Promise<boolean> {
  const snapshot = await readLockSnapshot(lockPath);
  if (!snapshot) return true;
  if (snapshot.kind === "legacy_file" || !snapshot.reclaimable) return false;
  if (snapshot.ownerPid !== undefined && processIsAlive(snapshot.ownerPid)) {
    return false;
  }
  if (snapshot.record && snapshot.ownerFileName) {
    return removeObservedOwner(lockPath, snapshot.ownerFileName);
  }
  const withinIncompleteLockGrace =
    Date.now() - snapshot.modifiedAtMs < INCOMPLETE_LOCK_GRACE_MS;
  if (withinIncompleteLockGrace) return false;
  if (snapshot.ownerFileName) {
    return removeObservedOwner(lockPath, snapshot.ownerFileName);
  }
  return removeEmptyLockTree(lockPath, snapshot.hasLeaseDirectory);
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return fileSystemErrorCode(error) !== "ESRCH";
  }
}

function isLockContention(error: unknown): boolean {
  const code = fileSystemErrorCode(error);
  return (
    code === "EEXIST" ||
    code === "ENOTEMPTY" ||
    code === "ENOTDIR" ||
    code === "EISDIR"
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
