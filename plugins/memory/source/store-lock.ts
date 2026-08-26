import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { MemoryStoreError } from "./types.js";

const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_RETRY_MS = 10;
const MAX_LOCK_BYTES = 1_024;
const INCOMPLETE_LOCK_GRACE_MS = 1_000;
const LEASE_DIRECTORY_NAME = "lease";
const OWNER_FILE_PATTERN =
  /^owner-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/iu;

type LockRecord = Readonly<{
  pid: number;
  token: string;
  createdAt: string;
}>;

type DirectoryLockSnapshot = Readonly<{
  kind: "directory";
  modifiedAtMs: number;
  hasLeaseDirectory: boolean;
  ownerFileName?: string;
  ownerPid?: number;
  record?: LockRecord;
  reclaimable: boolean;
}>;

type LockSnapshot = DirectoryLockSnapshot | Readonly<{ kind: "legacy" }>;

export type StoreLockOptions = Readonly<{
  waitMs?: number;
  retryMs?: number;
  processIsAlive?: (pid: number) => boolean;
}>;

function fileSystemErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return fileSystemErrorCode(error) !== "ESRCH";
  }
}

function ownerFileName(token: string): string {
  return `owner-${token}.json`;
}

function parseLockContents(
  raw: string,
  expectedToken: string,
): Readonly<{
  ownerPid?: number;
  record?: LockRecord;
}> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return Object.freeze({});
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({});
  }
  const record = value as Readonly<Record<string, unknown>>;
  const ownerPid =
    Number.isSafeInteger(record.pid) && Number(record.pid) > 0
      ? Number(record.pid)
      : undefined;
  if (
    ownerPid === undefined ||
    record.token !== expectedToken ||
    typeof record.createdAt !== "string" ||
    Number.isNaN(Date.parse(record.createdAt))
  ) {
    return Object.freeze({ ...(ownerPid === undefined ? {} : { ownerPid }) });
  }
  return Object.freeze({
    ownerPid,
    record: Object.freeze({
      pid: ownerPid,
      token: expectedToken,
      createdAt: record.createdAt,
    }),
  });
}

async function readOwnerRecord(
  lockPath: string,
  entryName: string,
  expectedToken: string,
  directoryModifiedAtMs: number,
): Promise<DirectoryLockSnapshot> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      join(lockPath, LEASE_DIRECTORY_NAME, entryName),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const info = await handle.stat({ bigint: true });
    const modifiedAtMs = Math.max(directoryModifiedAtMs, Number(info.mtimeMs));
    if (
      !info.isFile() ||
      info.size <= 0n ||
      info.size > BigInt(MAX_LOCK_BYTES)
    ) {
      return Object.freeze({
        kind: "directory",
        modifiedAtMs,
        hasLeaseDirectory: true,
        ownerFileName: entryName,
        reclaimable: true,
      });
    }
    const bytes = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead <= 0) {
        return Object.freeze({
          kind: "directory",
          modifiedAtMs,
          hasLeaseDirectory: true,
          ownerFileName: entryName,
          reclaimable: false,
        });
      }
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      !after.isFile() ||
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      after.size !== info.size ||
      after.mtimeNs !== info.mtimeNs ||
      after.ctimeNs !== info.ctimeNs
    ) {
      return Object.freeze({
        kind: "directory",
        modifiedAtMs,
        hasLeaseDirectory: true,
        ownerFileName: entryName,
        reclaimable: false,
      });
    }
    const parsed = parseLockContents(bytes.toString("utf8"), expectedToken);
    return Object.freeze({
      kind: "directory",
      modifiedAtMs,
      hasLeaseDirectory: true,
      ownerFileName: entryName,
      reclaimable: true,
      ...parsed,
    });
  } catch (error) {
    const code = fileSystemErrorCode(error);
    if (code === "ENOENT") {
      return Object.freeze({
        kind: "directory",
        modifiedAtMs: directoryModifiedAtMs,
        hasLeaseDirectory: true,
        reclaimable: false,
      });
    }
    if (code === "ELOOP") {
      return Object.freeze({
        kind: "directory",
        modifiedAtMs: directoryModifiedAtMs,
        hasLeaseDirectory: true,
        ownerFileName: entryName,
        reclaimable: true,
      });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readLockSnapshot(
  lockPath: string,
): Promise<LockSnapshot | undefined> {
  let lockInfo;
  try {
    lockInfo = await lstat(lockPath);
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!lockInfo.isDirectory()) {
    return Object.freeze({ kind: "legacy" });
  }

  let entries;
  try {
    entries = await readdir(lockPath, { withFileTypes: true });
  } catch (error) {
    const code = fileSystemErrorCode(error);
    if (code === "ENOENT") return undefined;
    if (code === "ENOTDIR") return Object.freeze({ kind: "legacy" });
    throw error;
  }
  if (entries.length === 0) {
    return Object.freeze({
      kind: "directory",
      modifiedAtMs: lockInfo.mtimeMs,
      hasLeaseDirectory: false,
      reclaimable: true,
    });
  }
  if (
    entries.length !== 1 ||
    entries[0]?.name !== LEASE_DIRECTORY_NAME ||
    !entries[0].isDirectory()
  ) {
    return Object.freeze({
      kind: "directory",
      modifiedAtMs: lockInfo.mtimeMs,
      hasLeaseDirectory: false,
      reclaimable: false,
    });
  }

  const leasePath = join(lockPath, LEASE_DIRECTORY_NAME);
  let leaseInfo;
  let leaseEntries;
  try {
    leaseInfo = await lstat(leasePath);
    if (!leaseInfo.isDirectory()) {
      return Object.freeze({
        kind: "directory",
        modifiedAtMs: lockInfo.mtimeMs,
        hasLeaseDirectory: false,
        reclaimable: false,
      });
    }
    leaseEntries = await readdir(leasePath, { withFileTypes: true });
  } catch (error) {
    const code = fileSystemErrorCode(error);
    if (code === "ENOENT") {
      return Object.freeze({
        kind: "directory",
        modifiedAtMs: lockInfo.mtimeMs,
        hasLeaseDirectory: false,
        reclaimable: false,
      });
    }
    throw error;
  }
  const modifiedAtMs = Math.max(lockInfo.mtimeMs, leaseInfo.mtimeMs);
  if (leaseEntries.length === 0) {
    return Object.freeze({
      kind: "directory",
      modifiedAtMs,
      hasLeaseDirectory: true,
      reclaimable: true,
    });
  }
  if (leaseEntries.length !== 1 || !leaseEntries[0]?.isFile()) {
    return Object.freeze({
      kind: "directory",
      modifiedAtMs,
      hasLeaseDirectory: true,
      reclaimable: false,
    });
  }
  const entryName = leaseEntries[0].name;
  const token = OWNER_FILE_PATTERN.exec(entryName)?.[1];
  if (!token) {
    return Object.freeze({
      kind: "directory",
      modifiedAtMs,
      hasLeaseDirectory: true,
      reclaimable: false,
    });
  }
  return readOwnerRecord(lockPath, entryName, token, modifiedAtMs);
}

async function removeDirectoryIfEmpty(path: string): Promise<boolean> {
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

async function removeEmptyLockTree(
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

async function removeObservedOwner(
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

async function removeAbandonedLock(
  lockPath: string,
  processIsAlive: (pid: number) => boolean,
): Promise<boolean> {
  const snapshot = await readLockSnapshot(lockPath);
  if (!snapshot) return true;
  if (snapshot.kind === "legacy" || !snapshot.reclaimable) return false;
  if (snapshot.ownerPid !== undefined && processIsAlive(snapshot.ownerPid)) {
    return false;
  }
  if (snapshot.record && snapshot.ownerFileName) {
    return removeObservedOwner(lockPath, snapshot.ownerFileName);
  }
  if (Date.now() - snapshot.modifiedAtMs < INCOMPLETE_LOCK_GRACE_MS) {
    return false;
  }
  if (snapshot.ownerFileName) {
    return removeObservedOwner(lockPath, snapshot.ownerFileName);
  }
  return removeEmptyLockTree(lockPath, snapshot.hasLeaseDirectory);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isLockConflict(error: unknown): boolean {
  const code = fileSystemErrorCode(error);
  return (
    code === "EEXIST" ||
    code === "ENOTEMPTY" ||
    code === "ENOTDIR" ||
    code === "EISDIR"
  );
}

async function removeStagingLock(
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

async function installLockDirectory(
  lockPath: string,
  token: string,
): Promise<void> {
  const stagingPath = `${lockPath}.${process.pid}.${token}.pending`;
  const stagingOwnerPath = join(stagingPath, ownerFileName(token));
  let handle: FileHandle | undefined;
  let installed = false;
  let claimedLockPath = false;
  try {
    await mkdir(stagingPath, { mode: 0o700 });
    handle = await open(stagingOwnerPath, "wx", 0o600);
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );
    await handle.sync();
    await handle.close();
    handle = undefined;
    await mkdir(lockPath, { mode: 0o700 });
    claimedLockPath = true;
    await rename(stagingPath, join(lockPath, LEASE_DIRECTORY_NAME));
    installed = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!installed) {
      await removeStagingLock(stagingPath, stagingOwnerPath);
      if (claimedLockPath) {
        await removeDirectoryIfEmpty(lockPath);
      }
    }
  }
}

export async function acquireStoreLock(
  filePath: string,
  options: StoreLockOptions = {},
): Promise<() => Promise<void>> {
  const lockPath = `${filePath}.lock`;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const processIsAlive = options.processIsAlive ?? defaultProcessIsAlive;
  const deadline = Date.now() + waitMs;
  await mkdir(dirname(filePath), { recursive: true });

  while (true) {
    const token = randomUUID();
    try {
      await installLockDirectory(lockPath, token);
      let released = false;
      return async () => {
        if (released) return;
        await removeObservedOwner(lockPath, ownerFileName(token));
        released = true;
      };
    } catch (error) {
      if (!isLockConflict(error)) {
        throw new MemoryStoreError(
          "memory_store_unavailable",
          "Memory store is unavailable.",
        );
      }
      let removed = false;
      try {
        removed = await removeAbandonedLock(lockPath, processIsAlive);
      } catch {
        throw new MemoryStoreError(
          "memory_store_unavailable",
          "Memory store is unavailable.",
        );
      }
      if (removed) continue;
      if (Date.now() >= deadline) {
        throw new MemoryStoreError(
          "memory_store_busy",
          "Memory store is busy.",
        );
      }
      await delay(Math.min(retryMs, Math.max(deadline - Date.now(), 0)));
    }
  }
}
