import { channel } from "node:diagnostics_channel";

export const MEMORY_STORAGE_FAILURE_CHANNEL = "abot.memory.storage-failure";
const failures = channel(MEMORY_STORAGE_FAILURE_CHANNEL);
const filesystemCodes = new Set([
  "EACCES", "EBADF", "EBUSY", "EDQUOT", "EEXIST", "EFAULT", "EFBIG",
  "EINTR", "EINVAL", "EIO", "EISDIR", "ELOOP", "EMFILE", "ENAMETOOLONG",
  "ENFILE", "ENOENT", "ENOMEM", "ENOSPC", "ENOTDIR", "ENOTEMPTY",
  "ENOTSUP", "EPERM", "EROFS", "ETXTBSY", "EXDEV",
]);
const filesystemCalls = new Set([
  "access", "close", "fstat", "fsync", "ftruncate", "lstat", "mkdir",
  "open", "opendir", "read", "readdir", "rename", "rmdir", "scandir",
  "stat", "unlink", "write",
]);

type MemoryStorageFailureStage =
  | "lock-install"
  | "lock-observe"
  | "initialize-access"
  | "legacy-read"
  | "read";

function memoryFilesystemFailureFields(error: unknown) {
  const unknown = { code: "unknown", syscall: "unknown" };
  if (!error || typeof error !== "object") return unknown;
  try {
    const { code, syscall } = error as { code?: unknown; syscall?: unknown };
    return {
      code: filesystemCodes.has(code as string) ? code as string : "unknown",
      syscall: filesystemCalls.has(syscall as string) ? syscall as string : "unknown",
    };
  } catch {
    return unknown;
  }
}

/** Internal subscribers receive only bounded OS identifiers, never memory or paths. */
export function reportMemoryStorageFailure(stage: MemoryStorageFailureStage, error: unknown): void {
  if (!failures.hasSubscribers) return;
  failures.publish(Object.freeze({ stage, ...memoryFilesystemFailureFields(error) }));
}
