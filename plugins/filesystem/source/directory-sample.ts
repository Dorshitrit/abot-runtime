import { constants, type BigIntStats } from "node:fs";
import {
  open,
  opendir,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { relative, sep } from "node:path";
import type { ResolvedRuntimeToolPath } from "../../../src/plugin-sdk/index.js";
import {
  DirectoryAuthorityError,
  runDirectoryAuthorityTask,
} from "../../../src/shared/directory-authority/index.js";
import { fail, rethrowFilesystemError } from "./errors.js";
import { sampleDirectoryTask } from "./directory-sample-task.js";

export const DIRECTORY_ENTRY_LIMIT = 160;

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
    if (requiresIsolatedDirectorySample()) {
      const sample = await runDirectoryAuthorityTask({
        directoryPath: target.absolutePath,
        directoryFd: handle.fd,
        input: { maxEntries: DIRECTORY_ENTRY_LIMIT },
        task: sampleDirectoryTask,
      });
      await assertDirectoryStable(handle, before, target.logicalPath);
      return sample;
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
    if (
      error instanceof DirectoryAuthorityError &&
      error.code.startsWith("directory_authority_")
    ) {
      fail(
        "filesystem_path_changed",
        `Directory authority was lost: ${target.logicalPath}`,
      );
    }
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

function requiresIsolatedDirectorySample(): boolean {
  return process.platform === "darwin";
}
