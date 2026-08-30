export const LOCK_RETRY_DELAY_MS = 10;
export const LOCK_ACQUIRE_TIMEOUT_MS = 2_000;
export const INCOMPLETE_LOCK_GRACE_MS = 30_000;
export const MAX_LOCK_RECORD_BYTES = 1_024;
export const LEASE_DIRECTORY_NAME = "lease";
export const OWNER_FILE_PATTERN =
  /^owner-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/iu;

export type FileLockOptions = Readonly<{
  waitMs?: number;
  retryDelayMs?: number;
  processIsAlive?: (pid: number) => boolean;
}>;

export type LockRecord = Readonly<{
  pid: number;
  token: string;
  createdAt: string;
}>;

export type DirectoryLockSnapshot = Readonly<{
  kind: "directory";
  modifiedAtMs: number;
  hasLeaseDirectory: boolean;
  ownerFileName?: string;
  ownerPid?: number;
  record?: LockRecord;
  reclaimable: boolean;
}>;

export type LockSnapshot =
  | DirectoryLockSnapshot
  | Readonly<{ kind: "legacy_file" }>;

export function ownerFileName(token: string): string {
  return `owner-${token}.json`;
}

export function directorySnapshot(
  snapshot: Omit<DirectoryLockSnapshot, "kind">,
): DirectoryLockSnapshot {
  return Object.freeze({ kind: "directory" as const, ...snapshot });
}

export function fileSystemErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
