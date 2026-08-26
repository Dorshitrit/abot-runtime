import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { relative, sep } from "node:path";

export type BoundedRegularFileReadFailure = Readonly<{
  ok: false;
  reason:
    | "not_regular_file"
    | "too_large"
    | "changed_during_read"
    | "outside_root"
    | "safe_open_unsupported";
  byteCount?: number;
}>;

export type BoundedRegularFileReadSuccess = Readonly<{
  ok: true;
  bytes: Buffer;
  byteCount: number;
}>;

export type BoundedRegularFileReadResult =
  | BoundedRegularFileReadSuccess
  | BoundedRegularFileReadFailure;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("The file read was cancelled.");
  error.name = "AbortError";
  throw error;
}

async function readExact(
  handle: FileHandle,
  buffer: Buffer,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  let offset = 0;
  while (offset < buffer.length) {
    throwIfAborted(signal);
    const result = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (result.bytesRead === 0) return false;
    offset += result.bytesRead;
  }
  return true;
}

export async function readBoundedRegularFile(
  absolutePath: string,
  options: Readonly<{
    maxBytes: number;
    rootPath: string;
    signal?: AbortSignal;
  }>,
): Promise<BoundedRegularFileReadResult> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  throwIfAborted(options.signal);
  if (typeof constants.O_NOFOLLOW !== "number") {
    return Object.freeze({ ok: false, reason: "safe_open_unsupported" });
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      return Object.freeze({ ok: false, reason: "not_regular_file" });
    }
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      realpath(options.rootPath),
      realpath(absolutePath),
    ]);
    const rootRelative = relative(canonicalRoot, canonicalTarget);
    if (
      rootRelative === ".." ||
      rootRelative.startsWith(`..${sep}`) ||
      rootRelative.startsWith(sep)
    ) {
      return Object.freeze({ ok: false, reason: "outside_root" });
    }
    const pathIdentity = await stat(canonicalTarget, { bigint: true });
    if (
      pathIdentity.dev !== before.dev ||
      pathIdentity.ino !== before.ino ||
      !pathIdentity.isFile()
    ) {
      return Object.freeze({ ok: false, reason: "changed_during_read" });
    }
    const byteCount = Number(before.size);
    if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
      return Object.freeze({
        ok: false,
        reason: "too_large",
        byteCount,
      });
    }
    if (byteCount > options.maxBytes) {
      return Object.freeze({
        ok: false,
        reason: "too_large",
        byteCount,
      });
    }
    const bytes = Buffer.alloc(byteCount);
    if (!(await readExact(handle, bytes, options.signal))) {
      return Object.freeze({
        ok: false,
        reason: "changed_during_read",
        byteCount,
      });
    }
    throwIfAborted(options.signal);
    const after = await handle.stat({ bigint: true });
    if (
      !after.isFile() ||
      Number(after.size) !== byteCount ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      return Object.freeze({
        ok: false,
        reason: "changed_during_read",
        byteCount: Number(after.size),
      });
    }
    return Object.freeze({ ok: true, bytes, byteCount });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
