import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { ResolvedRuntimeToolPath } from "../../../src/plugin-sdk/index.js";
import { fail, rethrowFilesystemError } from "./errors.js";
import {
  metadataFromStat,
  sameMetadata,
  type MutationFileMetadata,
} from "./file-version.js";
import { readWindowsFileSlices } from "./windows/operations.js";

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

export async function observeFileSlices(
  target: ResolvedRuntimeToolPath,
  options: Readonly<{
    headBytes: number;
    tailBytes: number;
    maximumFileBytes?: number;
  }>,
): Promise<
  Readonly<{ metadata: MutationFileMetadata; head: Buffer; tail: Buffer }>
> {
  if (process.platform === "win32")
    return readWindowsFileSlices(target, options);
  const file = await openRegularFile(target);
  try {
    if (
      options.maximumFileBytes !== undefined &&
      file.size > options.maximumFileBytes
    )
      fail(
        "file_too_large",
        `File exceeds the mutation byte limit: ${target.logicalPath}`,
        { byteCount: file.size, maxBytes: options.maximumFileBytes },
      );
    const complete = file.size <= options.headBytes + options.tailBytes;
    const head = Buffer.alloc(complete ? file.size : options.headBytes);
    const tail = Buffer.alloc(complete ? 0 : options.tailBytes);
    await readExactBytes(file.handle, head, 0, target.logicalPath);
    await readExactBytes(
      file.handle,
      tail,
      file.size - tail.length,
      target.logicalPath,
    );
    const after = metadataFromStat(
      await file.handle.stat({ bigint: true }),
      target.logicalPath,
    );
    if (!sameMetadata(file.metadata, after))
      fail(
        "filesystem_read_changed",
        `File changed while it was being read: ${target.logicalPath}`,
      );
    return Object.freeze({ metadata: file.metadata, head, tail });
  } catch (error) {
    return rethrowFilesystemError(error, "read", target.logicalPath);
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}
