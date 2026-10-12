import { open, type FileHandle } from "node:fs/promises";
import { win32 } from "node:path";
import type { ResolvedRuntimeToolPath } from "../../../../src/plugin-sdk/index.js";
import { fail, rethrowFilesystemError } from "../errors.js";
import type { MutationFileMetadata } from "../file-version.js";
import type { MutationTargetVersion } from "../bounded-io.js";
import { executeWindowsFilesystem } from "./request-availability.js";

type NativeMetadata = {
  device: string;
  inode: string;
  size: number;
  mode: number;
  modifiedNs: string;
  changedNs: string;
};

async function withTarget<Result>(
  target: ResolvedRuntimeToolPath,
  run: (
    request: Readonly<Record<string, unknown>>,
    root: FileHandle,
  ) => Promise<Result>,
): Promise<Result> {
  const expectedPath = win32.resolve(target.rootPath, target.relativePath);
  if (win32.relative(expectedPath, target.absolutePath) !== "")
    fail(
      "filesystem_path_changed",
      "The resolved file target no longer matches its root.",
    );
  const relative = win32.relative(target.rootPath, expectedPath);
  if (
    win32.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith("..\\")
  )
    fail(
      "filesystem_path_changed",
      "The file target is outside its configured root.",
    );
  let root: FileHandle | undefined;
  try {
    root = await open(target.rootPath, "r");
    const identity = await root.stat({ bigint: true });
    if (!identity.isDirectory())
      fail("not_a_directory", "The configured root is not a directory.");
    if (identity.ino <= 0n)
      fail(
        "filesystem_safe_io_unsupported",
        "The configured filesystem does not provide a stable file identity.",
      );
    return await run(
      {
        rootPath: target.rootPath,
        relativePath: target.relativePath,
        rootIdentity: {
          device: String(identity.dev),
          inode: String(identity.ino),
          birthtimeNs: String(identity.birthtimeNs),
        },
      },
      root,
    );
  } catch (error) {
    return rethrowFilesystemError(error, "inspect", target.logicalPath);
  } finally {
    await root?.close().catch(() => undefined);
  }
}

function decodeMetadata(value: NativeMetadata): MutationFileMetadata {
  const validSize = Number.isSafeInteger(value?.size) && value.size >= 0;
  if (!validSize || !Number.isSafeInteger(value?.mode))
    fail(
      "filesystem_windows_response_invalid",
      "The filesystem helper returned invalid file metadata.",
    );
  const fields = [value.device, value.inode, value.modifiedNs, value.changedNs];
  if (
    !fields.every(
      (field) => typeof field === "string" && /^-?\d{1,30}$/u.test(field),
    )
  )
    fail(
      "filesystem_windows_response_invalid",
      "The filesystem helper returned invalid file identity.",
    );
  return Object.freeze({
    device: BigInt(value.device),
    inode: BigInt(value.inode),
    size: value.size,
    mode: value.mode,
    modifiedNs: BigInt(value.modifiedNs),
    changedNs: BigInt(value.changedNs),
  });
}

export async function readWindowsFileSlices(
  target: ResolvedRuntimeToolPath,
  options: Readonly<{
    headBytes: number;
    tailBytes: number;
    maximumFileBytes?: number;
  }>,
): Promise<
  Readonly<{ metadata: MutationFileMetadata; head: Buffer; tail: Buffer }>
> {
  return withTarget(target, async (request) => {
    const result = (await executeWindowsFilesystem({
      ...request,
      operation: "read",
      ...options,
      maximumFileBytes: options.maximumFileBytes ?? 0,
    })) as { metadata: NativeMetadata; head: string; tail: string };
    const metadata = decodeMetadata(result?.metadata);
    if (typeof result.head !== "string" || typeof result.tail !== "string")
      fail(
        "filesystem_windows_response_invalid",
        "The filesystem helper returned invalid file bytes.",
      );
    const head = Buffer.from(result.head, "base64"),
      tail = Buffer.from(result.tail, "base64");
    const complete = metadata.size <= options.headBytes + options.tailBytes;
    const expectedHead = complete ? metadata.size : options.headBytes;
    const expectedTail = complete ? 0 : options.tailBytes;
    if (head.length !== expectedHead || tail.length !== expectedTail)
      fail(
        "filesystem_read_incomplete",
        "The filesystem helper returned incomplete file bytes.",
      );
    return Object.freeze({ metadata, head, tail });
  });
}

export async function sampleWindowsDirectory(
  target: ResolvedRuntimeToolPath,
  maxEntries: number,
): Promise<Readonly<{ entries: readonly string[]; truncated: boolean }>> {
  return withTarget(target, async (request) => {
    const result = (await executeWindowsFilesystem({
      ...request,
      operation: "sample",
      maxEntries,
    })) as {
      entries: string[];
      truncated: boolean;
    };
    if (
      !Array.isArray(result?.entries) ||
      result.entries.length > maxEntries ||
      !result.entries.every((entry) => typeof entry === "string") ||
      typeof result.truncated !== "boolean"
    )
      fail(
        "filesystem_windows_response_invalid",
        "The filesystem helper returned an invalid directory sample.",
      );
    return Object.freeze({
      entries: Object.freeze(result.entries.sort((a, b) => a.localeCompare(b))),
      truncated: result.truncated,
    });
  });
}

export async function writeWindowsFile(
  input: Readonly<{
    target: ResolvedRuntimeToolPath;
    content: string;
    expectedVersion: MutationTargetVersion;
    onCommitted?: (root: FileHandle) => void;
  }>,
): Promise<void> {
  await withTarget(input.target, async (request, root) => {
    const expected = Object.fromEntries(
      Object.entries(input.expectedVersion).map(([key, value]) => [
        key,
        typeof value === "bigint" ? String(value) : value,
      ]),
    );
    const result = (await executeWindowsFilesystem({
      ...request,
      operation: "write",
      content: Buffer.from(input.content, "utf8").toString("base64"),
      expected,
    })) as { committed?: unknown };
    if (result?.committed !== true)
      fail(
        "filesystem_windows_response_invalid",
        "The filesystem helper did not confirm the write; do not repeat it automatically.",
      );
    try {
      input.onCommitted?.(root);
    } catch {
      /* Presentation cannot undo a committed write. */
    }
  });
}
