import { open, realpath, type FileHandle } from "node:fs/promises";
import { win32 } from "node:path";
import type { BigIntStats } from "node:fs";
import type { ResolvedRuntimeToolPath } from "../../../src/plugin-sdk/index.js";
import { LocalSearchError } from "./errors.js";
import type { SearchRoot } from "./paths.js";

export type WindowsSearchIdentity = Readonly<{
  device: string;
  inode: string;
  birthtimeNs: string;
}>;
export type WindowsSearchAuthority = Readonly<{
  platform: "win32";
  rootPath: string;
  targetPath: string;
  rootIdentity: WindowsSearchIdentity;
  targetIdentity: WindowsSearchIdentity;
  isFile: boolean;
}>;

function identity(stats: BigIntStats): WindowsSearchIdentity {
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
    birthtimeNs: String(stats.birthtimeNs),
  };
}

function sameWindowsPath(left: string, right: string): boolean {
  return (
    win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase()
  );
}

export function windowsSearchAuthorityUnavailable(): LocalSearchError {
  return new LocalSearchError(
    "local_search_authority_unavailable",
    "Local search could not keep the selected Windows path safely bound to its authorized root. No results were returned. Do not retry or bypass this restriction with another tool; ask the user to check the path and access permissions.",
  );
}

export async function openWindowsSearchAuthority(
  target: ResolvedRuntimeToolPath,
): Promise<SearchRoot> {
  const handles: FileHandle[] = [];
  try {
    const root = await open(target.rootPath, "r");
    handles.push(root);
    const selected = await open(target.absolutePath, "r");
    handles.push(selected);
    const [rootStats, selectedStats, rootPath, targetPath] = await Promise.all([
      root.stat({ bigint: true }),
      selected.stat({ bigint: true }),
      realpath(target.rootPath),
      realpath(target.absolutePath),
    ]);
    if (!rootStats.isDirectory()) throw windowsSearchAuthorityUnavailable();
    if (!sameWindowsPath(rootPath, target.rootPath))
      throw windowsSearchAuthorityUnavailable();
    if (!sameWindowsPath(targetPath, target.absolutePath))
      throw windowsSearchAuthorityUnavailable();
    if (!selectedStats.isFile() && !selectedStats.isDirectory()) {
      throw new LocalSearchError(
        "local_search_target_invalid",
        "The selected search target must be a regular file or directory.",
      );
    }
    const isFile = selectedStats.isFile();
    return Object.freeze({
      target,
      isFile,
      commandDirectory: isFile ? win32.dirname(targetPath) : targetPath,
      commandTarget: isFile ? win32.basename(targetPath) : ".",
      directoryAuthority: {
        platform: "win32" as const,
        rootPath,
        targetPath,
        rootIdentity: identity(rootStats),
        targetIdentity: identity(selectedStats),
        isFile,
      },
      close: async () => {
        for (const handle of handles.splice(0)) await handle.close();
      },
    });
  } catch (error) {
    await Promise.all(handles.splice(0).map((handle) => handle.close()));
    if (error instanceof LocalSearchError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new LocalSearchError(
        "local_search_root_not_found",
        "The selected logical search root does not exist.",
      );
    }
    throw windowsSearchAuthorityUnavailable();
  }
}
