import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, open, opendir, readlink } from "node:fs/promises";
import { join, posix } from "node:path";

import { sanitizeJsonText } from "../../../src/plugin-sdk/index.js";

import type {
  ExecActionSummary,
  ExecFilesystemDelta,
  ExecFilesystemEntry,
  ExecFilesystemSnapshot,
} from "./types.js";

const SNAPSHOT_MAX_ENTRIES = 4_096;
const SNAPSHOT_MAX_HASHED_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_MAX_HASHED_FILE_BYTES = 2 * 1024 * 1024;
const DELTA_ACTION_LIMIT = 64;
const ACTION_TARGET_MAX_CHARS = 96;

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function hashBuffer(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readBoundedDirectory(
  absoluteDirectory: string,
  maxItems: number,
): Promise<Readonly<{ children: readonly Dirent[]; complete: boolean }>> {
  let directory;
  try {
    directory = await opendir(absoluteDirectory);
  } catch (error) {
    if (isMissingPathError(error)) {
      return Object.freeze({ children: Object.freeze([]), complete: true });
    }
    throw error;
  }
  const children: Dirent[] = [];
  let complete = true;
  try {
    while (true) {
      const child = await directory.read();
      if (!child) break;
      if (children.length >= maxItems) {
        complete = false;
        break;
      }
      children.push(child);
    }
  } finally {
    await directory.close().catch((error: unknown) => {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ERR_DIR_CLOSED"
      ) {
        throw error;
      }
    });
  }
  children.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze({ children: Object.freeze(children), complete });
}

async function inspectRegularFile(
  absolutePath: string,
  remainingHashBytes: number,
): Promise<
  | Readonly<{
      entry: ExecFilesystemEntry;
      hashedBytes: number;
    }>
  | undefined
> {
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

export async function captureExecFilesystemSnapshot(
  absoluteRoot: string,
  logicalRoot: string,
): Promise<ExecFilesystemSnapshot> {
  const entries = new Map<string, ExecFilesystemEntry>();
  let remainingHashBytes = SNAPSHOT_MAX_HASHED_BYTES;
  let complete = true;
  const rootInfo = await lstat(absoluteRoot).catch((error: unknown) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!rootInfo) {
    return Object.freeze({
      absoluteRoot,
      logicalRoot,
      rootExists: false,
      complete: true,
      entries,
    });
  }

  const pendingDirectories = [""];
  while (pendingDirectories.length > 0 && complete) {
    const relativeDirectory = pendingDirectories.pop() ?? "";
    const absoluteDirectory = relativeDirectory
      ? join(absoluteRoot, relativeDirectory)
      : absoluteRoot;
    const directory = await readBoundedDirectory(
      absoluteDirectory,
      SNAPSHOT_MAX_ENTRIES - entries.size,
    );
    for (const child of directory.children) {
      const relativePath = relativeDirectory
        ? join(relativeDirectory, child.name)
        : child.name;
      const absolutePath = join(absoluteRoot, relativePath);
      const info = await lstat(absolutePath).catch((error: unknown) => {
        if (isMissingPathError(error)) return null;
        throw error;
      });
      if (!info) continue;
      if (info.isDirectory()) {
        entries.set(
          relativePath,
          Object.freeze({
            kind: "directory",
            mode: info.mode,
            size: info.size,
            mtimeMs: info.mtimeMs,
          }),
        );
        pendingDirectories.push(relativePath);
        continue;
      }
      if (info.isSymbolicLink()) {
        const linkTarget = await readlink(absolutePath).catch(() => undefined);
        entries.set(
          relativePath,
          Object.freeze({
            kind: "symlink",
            mode: info.mode,
            size: info.size,
            mtimeMs: info.mtimeMs,
            ...(linkTarget === undefined ? {} : { linkTarget }),
          }),
        );
        continue;
      }
      if (info.isFile()) {
        const inspected = await inspectRegularFile(
          absolutePath,
          remainingHashBytes,
        );
        if (!inspected) {
          complete = false;
          continue;
        }
        entries.set(relativePath, inspected.entry);
        remainingHashBytes -= inspected.hashedBytes;
        continue;
      }
      entries.set(
        relativePath,
        Object.freeze({
          kind: "other",
          mode: info.mode,
          size: info.size,
          mtimeMs: info.mtimeMs,
        }),
      );
    }
    if (!directory.complete) complete = false;
  }
  return Object.freeze({
    absoluteRoot,
    logicalRoot,
    rootExists: true,
    complete,
    entries,
  });
}

function entryChanged(
  before: ExecFilesystemEntry,
  after: ExecFilesystemEntry,
): boolean {
  if (before.kind !== after.kind || before.mode !== after.mode) return true;
  if (before.kind === "directory") return false;
  if (before.kind === "symlink") return before.linkTarget !== after.linkTarget;
  if (
    before.kind === "file" &&
    before.contentHash !== undefined &&
    after.contentHash !== undefined
  ) {
    return before.contentHash !== after.contentHash;
  }
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

function logicalChild(root: string, relativePath: string): string {
  const target = sanitizeJsonText(
    root === "."
      ? relativePath.replaceAll("\\", "/")
      : posix.join(root, relativePath.replaceAll("\\", "/")),
  );
  const characters = [...target];
  if (characters.length <= ACTION_TARGET_MAX_CHARS) return target;
  const separator = "…";
  const sideChars = Math.floor(
    (ACTION_TARGET_MAX_CHARS - separator.length) / 2,
  );
  return `${characters.slice(0, sideChars).join("")}${separator}${characters.slice(-sideChars).join("")}`;
}

function actionForDelta(params: {
  logicalRoot: string;
  relativePath: string;
  before?: ExecFilesystemEntry;
  after?: ExecFilesystemEntry;
}): ExecActionSummary {
  const target = logicalChild(params.logicalRoot, params.relativePath);
  if (!params.before && params.after?.kind === "directory") {
    return { type: "mkdir", target, details: "exec_filesystem_created" };
  }
  if (!params.before && params.after?.kind === "file") {
    return { type: "write_file", target, details: "exec_filesystem_created" };
  }
  return {
    type: "refine_target",
    target,
    details: params.after
      ? "exec_filesystem_modified"
      : "exec_filesystem_removed",
  };
}

export function diffExecFilesystemSnapshots(
  before: ExecFilesystemSnapshot,
  after: ExecFilesystemSnapshot,
): ExecFilesystemDelta {
  if (
    before.absoluteRoot !== after.absoluteRoot ||
    before.logicalRoot !== after.logicalRoot
  ) {
    throw new TypeError(
      "Exec filesystem snapshots must share one observation root.",
    );
  }

  let changes: Array<{
    relativePath: string;
    before?: ExecFilesystemEntry;
    after?: ExecFilesystemEntry;
  }>;
  if (before.rootExists !== after.rootExists) {
    changes = [{ relativePath: "" }];
  } else if (!before.rootExists) {
    changes = [];
  } else {
    const candidatePaths =
      before.complete && after.complete
        ? new Set([...before.entries.keys(), ...after.entries.keys()])
        : new Set(
            [...before.entries.keys()].filter((entry) =>
              after.entries.has(entry),
            ),
          );
    changes = [...candidatePaths]
      .sort((left, right) => left.localeCompare(right))
      .flatMap((relativePath) => {
        const beforeEntry = before.entries.get(relativePath);
        const afterEntry = after.entries.get(relativePath);
        return beforeEntry === undefined ||
          afterEntry === undefined ||
          entryChanged(beforeEntry, afterEntry)
          ? [
              {
                relativePath,
                ...(beforeEntry === undefined ? {} : { before: beforeEntry }),
                ...(afterEntry === undefined ? {} : { after: afterEntry }),
              },
            ]
          : [];
      });
  }

  const actions = changes.slice(0, DELTA_ACTION_LIMIT).map((entry) =>
    entry.relativePath
      ? actionForDelta({ logicalRoot: before.logicalRoot, ...entry })
      : {
          type: "refine_target",
          target: logicalChild(".", before.logicalRoot),
          details: after.rootExists
            ? "exec_filesystem_created"
            : "exec_filesystem_removed",
        },
  );
  return Object.freeze({
    observedStateChange: changes.length > 0,
    changedEntryCount: changes.length,
    actions: Object.freeze(actions),
    observation: Object.freeze({
      complete: before.complete && after.complete,
      actionLimit: DELTA_ACTION_LIMIT,
      actionsTruncated: changes.length > actions.length,
    }),
  });
}
