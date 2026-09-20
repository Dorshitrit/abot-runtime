import {
  constants,
  fstatSync,
  lstatSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolFileOutputReceipt } from "../../capabilities/file-output-presentation.js";
import type { ResolvedRuntimeToolPath } from "../../capabilities/tool-types.js";
import type { RuntimePaths } from "../../runtime/ports.js";
import { createRuntimeToolPathResolver } from "../../runtime/capabilities/runtime-target-path.js";
import { readFileOutputRootId } from "../../runtime/capabilities/file-output-root-identity.js";
import { ConversationFileError } from "./conversation-file-format.js";

function unavailable(): never {
  throw new ConversationFileError(
    "conversation_file_unavailable",
    404,
    "This file is no longer available in its original location.",
  );
}

function changedRoot(): never {
  throw new ConversationFileError(
    "conversation_file_root_changed",
    409,
    "The configured location changed. This earlier file cannot be opened here.",
  );
}

function changedFile(): never {
  throw new ConversationFileError(
    "conversation_file_changed",
    409,
    "The file changed while it was being read. Open it again to see the current content.",
  );
}

async function assertRecordedRootIdentity(
  receipt: ToolFileOutputReceipt,
  canonicalRoot: string,
): Promise<void> {
  let currentRootId: string;
  try {
    currentRootId = readFileOutputRootId(receipt.location, canonicalRoot);
  } catch {
    return changedRoot();
  }
  if (currentRootId !== receipt.rootId) changedRoot();
}

async function resolveRecordedFile(
  receipt: ToolFileOutputReceipt,
  paths: RuntimePaths,
): Promise<ResolvedRuntimeToolPath> {
  const resolver = createRuntimeToolPathResolver(paths);
  const options = { allowedLocations: [receipt.location], requirePath: true };
  let root: ResolvedRuntimeToolPath;
  try {
    root = resolver.resolve(
      receipt.location === "workspace" ? "workspace" : ".",
      options,
    );
  } catch {
    return changedRoot();
  }
  await assertRecordedRootIdentity(receipt, root.rootPath);
  let target: ResolvedRuntimeToolPath;
  try {
    target = resolver.resolve(
      resolve(root.rootPath, receipt.relativePath),
      options,
    );
  } catch {
    return unavailable();
  }
  if (target.location !== receipt.location) unavailable();
  if (target.relativePath !== receipt.relativePath) unavailable();
  if (target.logicalPath !== receipt.logicalPath) unavailable();
  if (target.rootPath !== root.rootPath) changedRoot();
  return target;
}

function isContainedFile(root: string, path: string): boolean {
  const value = relative(root, path);
  if (!value || isAbsolute(value)) return false;
  if (value === "..") return false;
  return !value.startsWith(".." + sep);
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  if (left.dev !== right.dev) return false;
  return left.ino === right.ino;
}

function sameFileVersion(left: BigIntStats, right: BigIntStats): boolean {
  if (!sameFileIdentity(left, right)) return false;
  if (left.size !== right.size) return false;
  if (left.mtimeNs !== right.mtimeNs) return false;
  return left.ctimeNs === right.ctimeNs;
}

async function assertOpenedFileAuthority(
  target: ResolvedRuntimeToolPath,
  opened: BigIntStats,
  receipt: ToolFileOutputReceipt,
): Promise<void> {
  const root = await realpath(target.rootPath);
  await assertRecordedRootIdentity(receipt, root);
  const canonicalPath = await realpath(target.absolutePath);
  if (!isContainedFile(root, canonicalPath)) unavailable();
  const current = await stat(canonicalPath, { bigint: true });
  if (!current.isFile()) unavailable();
  if (!sameFileIdentity(opened, current)) changedFile();
}

export type OpenedConversationFile = {
  target: ResolvedRuntimeToolPath;
  handle: FileHandle;
  stats: BigIntStats;
  assertCurrent: () => Promise<void>;
  assertCurrentForNativeOpen: () => void;
};

/** Keeps the recorded file descriptor alive for the complete caller operation. */
export async function withConversationFileTarget<T>(
  receipt: ToolFileOutputReceipt,
  paths: RuntimePaths,
  action: (file: OpenedConversationFile) => Promise<T>,
): Promise<T> {
  let handle: FileHandle | undefined;
  try {
    const target = await resolveRecordedFile(receipt, paths);
    if (typeof constants.O_NOFOLLOW !== "number")
      throw new ConversationFileError(
        "conversation_file_platform_unsupported",
        415,
        "This platform cannot safely open a file preview.",
      );
    handle = await open(
      target.absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const openedHandle = handle;
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) unavailable();
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) unavailable();
    await assertOpenedFileAuthority(target, before, receipt);
    return await action({
      target,
      handle,
      stats: before,
      assertCurrent: async () => {
        const after = await openedHandle.stat({ bigint: true });
        if (!sameFileVersion(before, after)) changedFile();
        const currentTarget = await resolveRecordedFile(receipt, paths);
        if (currentTarget.absolutePath !== target.absolutePath) unavailable();
        await assertOpenedFileAuthority(target, after, receipt);
      },
      assertCurrentForNativeOpen: () => {
        assertNativeFileDispatchAuthority(
          target,
          openedHandle.fd,
          before,
          receipt,
          paths,
        );
      },
    });
  } catch (error) {
    if (error instanceof ConversationFileError) throw error;
    return unavailable();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** No await is allowed between this pathname check and native command dispatch. */
function assertNativeFileDispatchAuthority(
  target: ResolvedRuntimeToolPath,
  fd: number,
  before: BigIntStats,
  receipt: ToolFileOutputReceipt,
  paths: RuntimePaths,
): void {
  const resolver = createRuntimeToolPathResolver(paths);
  const current = resolver.resolve(target.absolutePath, {
    allowedLocations: [receipt.location],
    requirePath: true,
  });
  if (current.rootPath !== target.rootPath) changedRoot();
  if (current.relativePath !== receipt.relativePath) unavailable();
  const root = realpathSync(current.rootPath);
  if (readFileOutputRootId(receipt.location, root) !== receipt.rootId)
    changedRoot();
  const canonicalPath = realpathSync(current.absolutePath);
  if (!isContainedFile(root, canonicalPath)) unavailable();
  const opened = fstatSync(fd, { bigint: true });
  if (!sameFileVersion(before, opened)) changedFile();
  if (!lstatSync(current.absolutePath).isFile()) unavailable();
  const currentFile = statSync(canonicalPath, { bigint: true });
  if (!currentFile.isFile()) unavailable();
  if (!sameFileVersion(opened, currentFile)) changedFile();
}
