import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { ExecFilesystemEntry } from "./types.js";

const SNAPSHOT_MAX_HASHED_FILE_BYTES = 2 * 1024 * 1024;

export function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function hashBuffer(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function inspectExecRegularFile(
  absolutePath: string,
  remainingHashBytes: number,
): Promise<
  | Readonly<{
      entry: ExecFilesystemEntry;
      hashedBytes: number;
    }>
  | undefined
> {
  if (process.platform === "win32") {
    // Windows has no O_NOFOLLOW. Observe metadata without opening content or
    // following a reparse point; size/mtime deltas already support unhashed files.
    const info = await lstat(absolutePath).catch((error: unknown) => {
      if (isMissingPathError(error)) return null;
      throw error;
    });
    if (!info?.isFile()) return undefined;
    return Object.freeze({
      entry: Object.freeze({
        kind: "file" as const,
        mode: info.mode,
        size: info.size,
        mtimeMs: info.mtimeMs,
      }),
      hashedBytes: 0,
    });
  }
  const noFollow = constants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow)) return undefined;
  let file;
  try {
    file = await open(absolutePath, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (
      isMissingPathError(error) ||
      (error instanceof Error && "code" in error && error.code === "ELOOP")
    ) {
      return undefined;
    }
    throw error;
  }
  try {
    const info: Stats = await file.stat();
    if (!info.isFile()) return undefined;
    let contentHash: string | undefined;
    let hashedBytes = 0;
    if (
      info.size <= SNAPSHOT_MAX_HASHED_FILE_BYTES &&
      info.size <= remainingHashBytes
    ) {
      const length = Math.max(0, Math.floor(info.size));
      const content = Buffer.alloc(length);
      while (hashedBytes < length) {
        const { bytesRead } = await file.read(
          content,
          hashedBytes,
          length - hashedBytes,
          hashedBytes,
        );
        if (bytesRead === 0) break;
        hashedBytes += bytesRead;
      }
      contentHash = hashBuffer(content.subarray(0, hashedBytes));
    }
    return Object.freeze({
      entry: Object.freeze({
        kind: "file",
        mode: info.mode,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ...(contentHash === undefined ? {} : { contentHash }),
      }),
      hashedBytes,
    });
  } finally {
    await file.close();
  }
}
