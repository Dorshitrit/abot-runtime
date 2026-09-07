import { randomUUID } from "node:crypto";
import { link, open, rename, rm } from "node:fs/promises";
import { posix } from "node:path";

import type { ResolvedRuntimeToolPath } from "../../../src/plugin-sdk/index.js";

import {
  assertMutationContentSize,
  assertMutationTargetUnchanged,
  type MutationTargetVersion,
} from "./bounded-io.js";
import { fail, isNodeErrorCode, rethrowFilesystemError } from "./errors.js";
import { openMutationParent } from "./mutation-parent.js";
import { writeWithDirectoryAuthority } from "./directory-authority-write.js";

export async function atomicWriteText(
  input: Readonly<{
    target: ResolvedRuntimeToolPath;
    content: string;
    expectedVersion: MutationTargetVersion;
  }>,
): Promise<void> {
  assertMutationContentSize(input.content);
  if (requiresIsolatedDirectoryAuthority()) {
    await writeWithDirectoryAuthority(input);
    return;
  }
  const parent = await openMutationParent(input.target);
  const targetPath = `${parent.procPath}/${parent.targetName}`;
  const anchoredTarget = Object.freeze({
    ...input.target,
    rootPath: parent.procPath,
    absolutePath: targetPath,
    relativePath: parent.targetName,
  });
  const temporaryName = `.abot-${posix.basename(parent.targetName)}-${randomUUID()}.tmp`;
  const temporaryPath = `${parent.procPath}/${temporaryName}`;
  const existingMode =
    input.expectedVersion.kind === "file"
      ? input.expectedVersion.mode
      : undefined;

  let temporaryCreated = false;
  try {
    const temporaryHandle = await open(temporaryPath, "wx");
    temporaryCreated = true;
    try {
      await temporaryHandle.writeFile(input.content, "utf8");
      if (existingMode !== undefined) {
        await temporaryHandle.chmod(existingMode);
      }
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await assertMutationTargetUnchanged(anchoredTarget, input.expectedVersion);
    await installPreparedFile({
      parentProcPath: parent.procPath,
      temporaryName,
      targetName: parent.targetName,
      logicalPath: input.target.logicalPath,
      expectedKind: input.expectedVersion.kind,
    });
    if (input.expectedVersion.kind === "file") {
      temporaryCreated = false;
    } else {
      const removed = await rm(temporaryPath, { force: true })
        .then(() => true)
        .catch(() => false);
      temporaryCreated = !removed;
    }
    await syncDirectoryBestEffort(parent.handle);
  } catch (error: unknown) {
    rethrowFilesystemError(error, "write", input.target.logicalPath);
  } finally {
    if (temporaryCreated) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    await parent.handle.close().catch(() => undefined);
  }
}

async function installPreparedFile(
  input: Readonly<{
    parentProcPath: string;
    temporaryName: string;
    targetName: string;
    logicalPath: string;
    expectedKind: MutationTargetVersion["kind"];
  }>,
): Promise<void> {
  const temporaryPath = `${input.parentProcPath}/${input.temporaryName}`;
  const targetPath = `${input.parentProcPath}/${input.targetName}`;
  if (input.expectedKind === "file") {
    await rename(temporaryPath, targetPath);
    return;
  }
  try {
    await link(temporaryPath, targetPath);
  } catch (error: unknown) {
    if (isNodeErrorCode(error, "EEXIST")) {
      fail(
        "filesystem_target_changed",
        `Target changed before the write could commit: ${input.logicalPath}`,
      );
    }
    throw error;
  }
}

async function syncDirectoryBestEffort(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  try {
    await handle.sync();
  } catch {
    // Some supported filesystems do not expose directory fsync through Node.
    // The prepared file itself is always synced before the atomic install.
  }
}

function requiresIsolatedDirectoryAuthority(): boolean {
  return process.platform === "darwin";
}
