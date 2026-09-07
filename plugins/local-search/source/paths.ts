import { constants, type BigIntStats } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type {
  ResolvedRuntimeToolPath,
  RuntimePluginLoadContext,
} from "../../../src/plugin-sdk/index.js";
import { resolvePluginPath } from "../../../src/plugin-sdk/index.js";

import { LocalSearchError } from "./errors.js";
import type { SearchDirectoryAuthority } from "./ripgrep-process.js";

export type SearchRoot = Readonly<{
  target: ResolvedRuntimeToolPath;
  isFile: boolean;
  commandDirectory: string;
  commandTarget: string;
  stdinFd?: number;
  directoryAuthority?: SearchDirectoryAuthority;
  close(): Promise<void>;
}>;

function fsCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.isFile() === right.isFile() &&
    left.isDirectory() === right.isDirectory()
  );
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function authorityUnavailable(): LocalSearchError {
  return new LocalSearchError(
    "local_search_failed",
    "Local search could not establish a safe read authority for the selected logical root.",
  );
}

async function openSearchAuthority(
  target: ResolvedRuntimeToolPath,
): Promise<SearchRoot> {
  const supportsSearchAuthority = ["linux", "darwin"].includes(
    process.platform,
  );
  if (!supportsSearchAuthority) throw authorityUnavailable();
  const supportsAuthorityOpenFlags =
    Number.isInteger(constants.O_NOFOLLOW) &&
    Number.isInteger(constants.O_NONBLOCK);
  if (!supportsAuthorityOpenFlags) {
    throw authorityUnavailable();
  }

  let handle: FileHandle | undefined;
  let targetOpened = false;
  try {
    handle = await open(
      target.absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    targetOpened = true;
    const observed = await handle.stat({ bigint: true });
    if (!observed.isFile() && !observed.isDirectory()) {
      throw new LocalSearchError(
        "local_search_target_invalid",
        "The selected search target must be a regular file or directory.",
      );
    }

    const [canonicalRoot, canonicalTarget] = await Promise.all([
      realpath(target.rootPath),
      realpath(target.absolutePath),
    ]);
    if (
      path.resolve(canonicalRoot) !== path.resolve(target.rootPath) ||
      path.resolve(canonicalTarget) !== path.resolve(target.absolutePath) ||
      !isWithinRoot(canonicalRoot, canonicalTarget)
    ) {
      throw authorityUnavailable();
    }

    const [pathIdentity, descriptorIdentity] = await Promise.all([
      stat(canonicalTarget, { bigint: true }),
      process.platform === "linux"
        ? stat(`/proc/self/fd/${handle.fd}`, { bigint: true })
        : handle.stat({ bigint: true }),
    ]);
    if (
      !sameIdentity(observed, pathIdentity) ||
      !sameIdentity(observed, descriptorIdentity)
    ) {
      throw authorityUnavailable();
    }

    const authority = handle;
    const isFile = observed.isFile();
    const needsDirectoryBridge = !isFile && process.platform === "darwin";
    let commandDirectory = "/";
    if (!isFile) {
      commandDirectory =
        process.platform === "linux"
          ? `/proc/self/fd/${authority.fd}`
          : canonicalTarget;
    }
    let closed = false;
    handle = undefined;
    return Object.freeze({
      target,
      isFile,
      commandDirectory,
      commandTarget: isFile ? "-" : ".",
      ...(isFile ? { stdinFd: authority.fd } : {}),
      ...(needsDirectoryBridge
        ? {
            directoryAuthority: {
              directoryPath: canonicalTarget,
              directoryFd: authority.fd,
            },
          }
        : {}),
      close: async () => {
        if (closed) return;
        closed = true;
        await authority.close();
      },
    });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof LocalSearchError) throw error;
    const code = fsCode(error);
    if (!targetOpened && (code === "ENOENT" || code === "ENOTDIR")) {
      throw new LocalSearchError(
        "local_search_root_not_found",
        "The selected logical search root does not exist.",
      );
    }
    throw authorityUnavailable();
  }
}

export async function resolveSearchRoot(
  context: RuntimePluginLoadContext,
  rawPath: unknown,
): Promise<SearchRoot> {
  const requested =
    typeof rawPath === "string" && rawPath.trim() ? rawPath : ".";
  const target = resolvePluginPath(context, requested, {
    requirePath: true,
    allowedLocations: ["agent_work", "workspace"],
  });
  return openSearchAuthority(target);
}

function normalizeRelativeResult(value: string): string {
  const normalized = path.sep === "/" ? value : value.replaceAll(path.sep, "/");
  if (
    !normalized ||
    normalized.includes("\\") ||
    path.isAbsolute(normalized) ||
    /^[A-Za-z]:[\\/]/u.test(normalized) ||
    /^[\\/]{2}/u.test(normalized)
  ) {
    throw new LocalSearchError(
      "local_search_path_roundtrip_unsafe",
      "Local search found a path that cannot be reused as a logical path.",
    );
  }
  return normalized.replace(/^\.\/+/, "");
}

export function qualifyMatchPath(
  context: RuntimePluginLoadContext,
  root: SearchRoot,
  rawPath: string,
): string {
  const logical = root.isFile
    ? root.target.logicalPath
    : root.target.logicalPath === "."
      ? normalizeRelativeResult(rawPath)
      : path.posix.join(
          root.target.logicalPath,
          normalizeRelativeResult(rawPath),
        );
  const roundTrip = resolvePluginPath(context, logical, {
    requirePath: true,
    allowedLocations: ["agent_work", "workspace"],
  });
  const sourceAbsolutePath = root.isFile
    ? root.target.absolutePath
    : path.resolve(root.target.absolutePath, rawPath);
  if (
    roundTrip.logicalPath !== logical ||
    path.resolve(roundTrip.absolutePath) !== path.resolve(sourceAbsolutePath)
  ) {
    throw new LocalSearchError(
      "local_search_path_roundtrip_unsafe",
      "Local search found a path that cannot be reused as a logical path.",
    );
  }
  return logical;
}
