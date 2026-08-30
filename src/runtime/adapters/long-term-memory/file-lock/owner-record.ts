import { constants, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import {
  directorySnapshot,
  fileSystemErrorCode,
  LEASE_DIRECTORY_NAME,
  MAX_LOCK_RECORD_BYTES,
  type DirectoryLockSnapshot,
  type LockRecord,
} from "./contracts.js";

export async function readOwnerRecord(
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
    const before = await handle.stat({ bigint: true });
    const modifiedAtMs = Math.max(
      directoryModifiedAtMs,
      Number(before.mtimeMs),
    );
    const hasReadableRecord =
      before.isFile() &&
      before.size > 0n &&
      before.size <= BigInt(MAX_LOCK_RECORD_BYTES);
    if (!hasReadableRecord) {
      return directorySnapshot({
        modifiedAtMs,
        hasLeaseDirectory: true,
        ownerFileName: entryName,
        reclaimable: true,
      });
    }

    const raw = await readStableRecord(handle, before);
    if (raw === undefined) {
      return directorySnapshot({
        modifiedAtMs,
        hasLeaseDirectory: true,
        ownerFileName: entryName,
        reclaimable: false,
      });
    }
    const parsed = parseLockRecord(raw, expectedToken);
    return directorySnapshot({
      modifiedAtMs,
      hasLeaseDirectory: true,
      ownerFileName: entryName,
      reclaimable: true,
      ...parsed,
    });
  } catch (error) {
    return snapshotReadFailure(error, directoryModifiedAtMs, entryName);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readStableRecord(
  handle: FileHandle,
  before: BigIntStats,
): Promise<string | undefined> {
  const bytes = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (result.bytesRead <= 0) return undefined;
    offset += result.bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  const recordChangedWhileReading =
    !after.isFile() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs;
  return recordChangedWhileReading ? undefined : bytes.toString("utf8");
}

function snapshotReadFailure(
  error: unknown,
  modifiedAtMs: number,
  entryName: string,
): DirectoryLockSnapshot {
  const code = fileSystemErrorCode(error);
  if (code === "ENOENT") {
    return directorySnapshot({
      modifiedAtMs,
      hasLeaseDirectory: true,
      reclaimable: false,
    });
  }
  if (code === "ELOOP") {
    return directorySnapshot({
      modifiedAtMs,
      hasLeaseDirectory: true,
      ownerFileName: entryName,
      reclaimable: true,
    });
  }
  throw error;
}

function parseLockRecord(
  raw: string,
  expectedToken: string,
): Readonly<{ ownerPid?: number; record?: LockRecord }> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return Object.freeze({});
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({});
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  const ownerPid =
    Number.isSafeInteger(candidate.pid) && Number(candidate.pid) > 0
      ? Number(candidate.pid)
      : undefined;
  const hasValidRecord =
    ownerPid !== undefined &&
    candidate.token === expectedToken &&
    typeof candidate.createdAt === "string" &&
    Number.isFinite(Date.parse(candidate.createdAt));
  if (!hasValidRecord) {
    return Object.freeze({ ...(ownerPid === undefined ? {} : { ownerPid }) });
  }
  return Object.freeze({
    ownerPid,
    record: Object.freeze({
      pid: ownerPid,
      token: expectedToken,
      createdAt: candidate.createdAt as string,
    }),
  });
}
