import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  opendir,
  open,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";

import type { ResolvedRuntimeToolPath } from "../../../src/plugin-sdk/index.js";

import { fail, FilesystemToolError, rethrowFilesystemError } from "./errors.js";

export const MAX_MUTATION_BYTES = 1_048_576;
export const READ_HEAD_BYTES = 24_576;
export const READ_TAIL_BYTES = 12_288;
export const DEV_SCAN_BYTES = 1_048_576;
export const DIRECTORY_ENTRY_LIMIT = 160;

export type BoundedText = Readonly<{
  text: string;
  byteCount: number;
  bytesRead: number;
  omittedBytes: number;
  truncated: boolean;
}>;

type MutationFileMetadata = Readonly<{
  device: bigint;
  inode: bigint;
  size: number;
  mode: number;
  modifiedNs: bigint;
  changedNs: bigint;
}>;

export type MutationTargetVersion =
  | Readonly<{ kind: "absent" }>
  | Readonly<MutationFileMetadata & { kind: "file"; digest: string }>;

export type MutationSnapshot = Readonly<{
  content: string | null;
  version: MutationTargetVersion;
}>;

type PositionalFileReader = Readonly<{
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<Readonly<{ bytesRead: number }>>;
}>;

export async function readExactBytes(
  reader: PositionalFileReader,
  buffer: Buffer,
  position: number,
  logicalPath: string,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await reader.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (result.bytesRead <= 0 || result.bytesRead > buffer.length - offset) {
      fail(
        "filesystem_read_incomplete",
        `File changed or ended before a complete read: ${logicalPath}`,
      );
    }
    offset += result.bytesRead;
  }
}

function decodeCompletePrefix(buffer: Buffer): string {
  return new StringDecoder("utf8").write(buffer);
}

function decodeSuffix(buffer: Buffer): string {
  let start = 0;
  while (
    start < Math.min(4, buffer.length) &&
    (buffer[start]! & 0xc0) === 0x80
  ) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf8");
}

function decodeMutationText(buffer: Buffer, logicalPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail(
      "filesystem_invalid_encoding",
      `File is not valid UTF-8 text: ${logicalPath}`,
    );
  }
}

async function openRegularFile(target: ResolvedRuntimeToolPath): Promise<
  Readonly<{
    handle: FileHandle;
    size: number;
    metadata: MutationFileMetadata;
  }>
> {
  let handle: FileHandle | undefined;
  try {
    if (typeof constants.O_NOFOLLOW !== "number") {
      fail(
        "filesystem_safe_io_unsupported",
        "This platform does not provide the no-follow operation required for a safe read.",
      );
    }
    handle = await open(
      target.absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) {
      fail("not_a_file", `Expected a regular file: ${target.logicalPath}`);
    }
    const metadata = metadataFromStat(info, target.logicalPath);
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      realpath(target.rootPath),
      realpath(target.absolutePath),
    ]);
    const rootRelative = relative(canonicalRoot, canonicalTarget);
    if (
      rootRelative === ".." ||
      rootRelative.startsWith(`..${sep}`) ||
      rootRelative.startsWith(sep)
    ) {
      fail(
        "filesystem_path_changed",
        `File changed outside its configured root: ${target.logicalPath}`,
      );
    }
    const pathIdentity = await stat(canonicalTarget, { bigint: true });
    if (
      !pathIdentity.isFile() ||
      pathIdentity.dev !== info.dev ||
      pathIdentity.ino !== info.ino
    ) {
      fail(
        "filesystem_path_changed",
        `File changed while it was being opened: ${target.logicalPath}`,
      );
    }
    return Object.freeze({ handle, size: metadata.size, metadata });
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    rethrowFilesystemError(error, "inspect", target.logicalPath);
  }
}

export async function readBoundedText(
  target: ResolvedRuntimeToolPath,
  options: Readonly<{
    headBytes?: number;
    tailBytes?: number;
  }> = {},
): Promise<BoundedText> {
  const file = await openRegularFile(target);
  const headBytes = options.headBytes ?? READ_HEAD_BYTES;
  const tailBytes = options.tailBytes ?? READ_TAIL_BYTES;
  const byteBudget = headBytes + tailBytes;
  try {
    if (file.size <= byteBudget) {
      const buffer = Buffer.alloc(file.size);
      await readExactBytes(file.handle, buffer, 0, target.logicalPath);
      await assertFileStable(file, target.logicalPath);
      rejectBinary(buffer, target.logicalPath);
      return Object.freeze({
        text: decodeCompletePrefix(buffer),
        byteCount: file.size,
        bytesRead: file.size,
        omittedBytes: 0,
        truncated: false,
      });
    }
    const head = Buffer.alloc(headBytes);
    const tail = Buffer.alloc(tailBytes);
    await Promise.all([
      readExactBytes(file.handle, head, 0, target.logicalPath),
      readExactBytes(
        file.handle,
        tail,
        Math.max(0, file.size - tailBytes),
        target.logicalPath,
      ),
    ]);
    await assertFileStable(file, target.logicalPath);
    rejectBinary(head, target.logicalPath);
    rejectBinary(tail, target.logicalPath);
    const omittedBytes = Math.max(0, file.size - head.length - tail.length);
    return Object.freeze({
      text: [
        decodeCompletePrefix(head),
        `[${omittedBytes} bytes omitted from the middle]`,
        decodeSuffix(tail),
      ].join("\n"),
      byteCount: file.size,
      bytesRead: head.length + tail.length,
      omittedBytes,
      truncated: true,
    });
  } catch (error: unknown) {
    return rethrowFilesystemError(error, "read", target.logicalPath);
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

export async function readPrefixText(
  target: ResolvedRuntimeToolPath,
  maxBytes: number = DEV_SCAN_BYTES,
): Promise<BoundedText> {
  const file = await openRegularFile(target);
  try {
    const length = Math.min(file.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await readExactBytes(file.handle, buffer, 0, target.logicalPath);
    await assertFileStable(file, target.logicalPath);
    rejectBinary(buffer, target.logicalPath);
    return Object.freeze({
      text: decodeCompletePrefix(buffer),
      byteCount: file.size,
      bytesRead: length,
      omittedBytes: Math.max(0, file.size - length),
      truncated: length < file.size,
    });
  } catch (error: unknown) {
    rethrowFilesystemError(error, "read", target.logicalPath);
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

export async function readMutationSnapshot(
  target: ResolvedRuntimeToolPath,
): Promise<MutationSnapshot> {
  let file: Awaited<ReturnType<typeof openRegularFile>> | undefined;
  try {
    file = await openRegularFile(target);
    const byteCount = file.size;
    if (byteCount > MAX_MUTATION_BYTES) {
      fail(
        "file_too_large",
        `File exceeds the ${MAX_MUTATION_BYTES}-byte mutation limit: ${target.logicalPath}`,
        { byteCount, maxBytes: MAX_MUTATION_BYTES },
      );
    }
    const buffer = Buffer.alloc(byteCount);
    await readExactBytes(file.handle, buffer, 0, target.logicalPath);
    const afterRead = metadataFromStat(
      await file.handle.stat({ bigint: true }),
      target.logicalPath,
    );
    if (!sameMetadata(file.metadata, afterRead)) {
      failTargetChanged(target.logicalPath, "file", "file");
    }
    rejectBinary(buffer, target.logicalPath);
    return Object.freeze({
      content: decodeMutationText(buffer, target.logicalPath),
      version: Object.freeze({
        kind: "file",
        ...file.metadata,
        digest: digest(buffer),
      }),
    });
  } catch (error: unknown) {
    if (
      error instanceof FilesystemToolError &&
      error.code === "file_not_found"
    ) {
      return Object.freeze({
        content: null,
        version: Object.freeze({ kind: "absent" }),
      });
    }
    return rethrowFilesystemError(error, "read", target.logicalPath);
  } finally {
    await file?.handle.close().catch(() => undefined);
  }
}

export async function assertMutationTargetUnchanged(
  target: ResolvedRuntimeToolPath,
  expected: MutationTargetVersion,
): Promise<void> {
  let file: Awaited<ReturnType<typeof openRegularFile>> | undefined;
  try {
    file = await openRegularFile(target);
  } catch (error: unknown) {
    if (
      error instanceof FilesystemToolError &&
      error.code === "file_not_found"
    ) {
      if (expected.kind === "absent") return;
      failTargetChanged(target.logicalPath, expected.kind, "absent");
    }
    throw error;
  }

  try {
    if (expected.kind === "absent") {
      failTargetChanged(target.logicalPath, "absent", "file");
    }
    if (!sameMetadata(expected, file.metadata)) {
      failTargetChanged(target.logicalPath, "file", "file");
    }
    const buffer = Buffer.alloc(file.size);
    await readExactBytes(file.handle, buffer, 0, target.logicalPath);
    const afterRead = metadataFromStat(
      await file.handle.stat({ bigint: true }),
      target.logicalPath,
    );
    if (
      !sameMetadata(file.metadata, afterRead) ||
      digest(buffer) !== expected.digest
    ) {
      failTargetChanged(target.logicalPath, "file", "file");
    }
  } catch (error: unknown) {
    return rethrowFilesystemError(error, "inspect", target.logicalPath);
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

export function assertMutationContentSize(content: string): number {
  const byteCount = Buffer.byteLength(content, "utf8");
  if (byteCount > MAX_MUTATION_BYTES) {
    fail(
      "file_too_large",
      `Prepared content exceeds the ${MAX_MUTATION_BYTES}-byte mutation limit.`,
      { byteCount, maxBytes: MAX_MUTATION_BYTES },
    );
  }
  return byteCount;
}

export async function readDirectorySample(
  target: ResolvedRuntimeToolPath,
): Promise<Readonly<{ entries: readonly string[]; truncated: boolean }>> {
  const entries: string[] = [];
  let handle: FileHandle | undefined;
  try {
    if (
      typeof constants.O_DIRECTORY !== "number" ||
      typeof constants.O_NOFOLLOW !== "number"
    ) {
      fail(
        "filesystem_safe_io_unsupported",
        "This platform does not provide the no-follow directory operation required for a safe read.",
      );
    }
    handle = await open(
      target.absolutePath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isDirectory()) {
      fail("not_a_directory", `Expected a directory: ${target.logicalPath}`);
    }
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      realpath(target.rootPath),
      realpath(target.absolutePath),
    ]);
    const rootRelative = relative(canonicalRoot, canonicalTarget);
    if (
      rootRelative === ".." ||
      rootRelative.startsWith(`..${sep}`) ||
      rootRelative.startsWith(sep)
    ) {
      fail(
        "filesystem_path_changed",
        `Directory changed outside its configured root: ${target.logicalPath}`,
      );
    }
    const pathIdentity = await stat(canonicalTarget, { bigint: true });
    if (
      !pathIdentity.isDirectory() ||
      pathIdentity.dev !== before.dev ||
      pathIdentity.ino !== before.ino
    ) {
      fail(
        "filesystem_path_changed",
        `Directory changed while it was being opened: ${target.logicalPath}`,
      );
    }
    const directory = await opendir(`/proc/self/fd/${handle.fd}`);
    for await (const entry of directory) {
      if (entries.length >= DIRECTORY_ENTRY_LIMIT) {
        await assertDirectoryStable(handle, before, target.logicalPath);
        entries.sort((left, right) => left.localeCompare(right));
        return Object.freeze({
          entries: Object.freeze(entries),
          truncated: true,
        });
      }
      entries.push(`${entry.name}${entry.isDirectory() ? "/" : ""}`);
    }
    await assertDirectoryStable(handle, before, target.logicalPath);
    entries.sort((left, right) => left.localeCompare(right));
    return Object.freeze({ entries: Object.freeze(entries), truncated: false });
  } catch (error: unknown) {
    return rethrowFilesystemError(error, "inspect", target.logicalPath);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertDirectoryStable(
  handle: FileHandle,
  before: BigIntStats,
  logicalPath: string,
): Promise<void> {
  const after = await handle.stat({ bigint: true });
  if (
    !after.isDirectory() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs
  ) {
    fail(
      "filesystem_read_changed",
      `Directory changed while it was being read: ${logicalPath}`,
    );
  }
}

function rejectBinary(buffer: Buffer, logicalPath: string): void {
  if (buffer.includes(0)) {
    fail(
      "binary_file_unsupported",
      `Binary file is not supported: ${logicalPath}`,
    );
  }
}

function metadataFromStat(
  info: BigIntStats,
  logicalPath: string,
): MutationFileMetadata {
  if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("file_too_large", `File is too large to read safely: ${logicalPath}`);
  }
  return Object.freeze({
    device: info.dev,
    inode: info.ino,
    size: Number(info.size),
    mode: Number(info.mode) & 0o7777,
    modifiedNs: info.mtimeNs,
    changedNs: info.ctimeNs,
  });
}

function sameMetadata(
  left: MutationFileMetadata,
  right: MutationFileMetadata,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.modifiedNs === right.modifiedNs &&
    left.changedNs === right.changedNs
  );
}

async function assertFileStable(
  file: Readonly<{ handle: FileHandle; metadata: MutationFileMetadata }>,
  logicalPath: string,
): Promise<void> {
  const afterRead = metadataFromStat(
    await file.handle.stat({ bigint: true }),
    logicalPath,
  );
  if (!sameMetadata(file.metadata, afterRead)) {
    fail(
      "filesystem_read_changed",
      `File changed while it was being read: ${logicalPath}`,
    );
  }
}

function digest(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function failTargetChanged(
  logicalPath: string,
  expectedState: MutationTargetVersion["kind"],
  observedState: MutationTargetVersion["kind"],
): never {
  fail(
    "filesystem_target_changed",
    `Target changed while the mutation was being prepared; no file was written: ${logicalPath}`,
    { path: logicalPath, expectedState, observedState },
  );
}
