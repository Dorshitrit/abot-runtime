import { constants } from "node:fs";
import { mkdir, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { relative, sep } from "node:path";

import type { ResolvedRuntimeToolPath } from "../../../src/plugin-sdk/index.js";

import { fail, isNodeErrorCode, rethrowFilesystemError } from "./errors.js";

export type MutationParent = Readonly<{
  handle: FileHandle;
  procPath: string;
  targetName: string;
}>;

function isWithinRoot(target: string, root: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function sameIdentity(
  left: Readonly<{ dev: bigint; ino: bigint }>,
  right: Readonly<{ dev: bigint; ino: bigint }>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openDirectory(
  path: string,
  rootPath: string,
  logicalPath: string,
  allowMissing: boolean = false,
): Promise<FileHandle> {
  if (
    typeof constants.O_DIRECTORY !== "number" ||
    typeof constants.O_NOFOLLOW !== "number"
  ) {
    fail(
      "filesystem_safe_io_unsupported",
      "This platform does not provide the no-follow directory operations required for a safe write.",
    );
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory()) {
      fail("not_a_directory", `Expected a directory: ${logicalPath}`);
    }
    const [canonicalRoot, canonicalDirectory] = await Promise.all([
      realpath(rootPath),
      realpath(path),
    ]);
    if (!isWithinRoot(canonicalDirectory, canonicalRoot)) {
      fail(
        "filesystem_path_changed",
        `Directory changed outside its configured root: ${logicalPath}`,
      );
    }
    const pathIdentity = await stat(canonicalDirectory, { bigint: true });
    if (!pathIdentity.isDirectory() || !sameIdentity(opened, pathIdentity)) {
      fail(
        "filesystem_path_changed",
        `Directory changed while it was being opened: ${logicalPath}`,
      );
    }
    if (usesIsolatedDirectoryAuthority()) return handle;
    const procPath = `/proc/self/fd/${handle.fd}`;
    const procIdentity = await stat(procPath, { bigint: true });
    if (!procIdentity.isDirectory() || !sameIdentity(opened, procIdentity)) {
      fail(
        "filesystem_safe_io_unsupported",
        "The process file-descriptor filesystem is unavailable for a safe write.",
      );
    }
    return handle;
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    if (allowMissing && isNodeErrorCode(error, "ENOENT")) throw error;
    rethrowFilesystemError(error, "write", logicalPath);
  }
}

async function openChildDirectory(
  parent: FileHandle,
  name: string,
  logicalPath: string,
): Promise<FileHandle> {
  const anchoredPath = `/proc/self/fd/${parent.fd}/${name}`;
  try {
    return await openDirectory(
      anchoredPath,
      `/proc/self/fd/${parent.fd}`,
      logicalPath,
      true,
    );
  } catch (error: unknown) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
  }
  try {
    await mkdir(anchoredPath);
  } catch (error: unknown) {
    if (!isNodeErrorCode(error, "EEXIST")) {
      rethrowFilesystemError(error, "write", logicalPath);
    }
  }
  return openDirectory(anchoredPath, `/proc/self/fd/${parent.fd}`, logicalPath);
}

/**
 * Opens the mutation parent as a stable directory authority. Every descendant
 * is traversed relative to an already-open descriptor, so swapping an
 * intermediate pathname cannot redirect the eventual write outside the
 * configured root.
 */
export async function openMutationParent(
  target: ResolvedRuntimeToolPath,
): Promise<MutationParent> {
  const segments = target.relativePath.split("/").filter(Boolean);
  const targetName = segments.pop();
  if (!targetName || targetName === "." || targetName === "..") {
    fail("not_a_file", `Expected a file path: ${target.logicalPath}`);
  }
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/"),
    )
  ) {
    fail(
      "filesystem_path_changed",
      `Path changed while preparing the write: ${target.logicalPath}`,
    );
  }

  let current = await openDirectory(
    target.rootPath,
    target.rootPath,
    target.logicalPath,
  );
  try {
    for (const segment of segments) {
      const next = await openChildDirectory(
        current,
        segment,
        target.logicalPath,
      );
      await current.close();
      current = next;
    }
    return Object.freeze({
      handle: current,
      procPath: `/proc/self/fd/${current.fd}`,
      targetName,
    });
  } catch (error: unknown) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

function usesIsolatedDirectoryAuthority(): boolean {
  return process.platform === "darwin";
}

export function openMutationRoot(
  target: ResolvedRuntimeToolPath,
): Promise<FileHandle> {
  return openDirectory(target.rootPath, target.rootPath, target.logicalPath);
}
