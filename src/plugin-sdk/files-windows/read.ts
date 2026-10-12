import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { win32 } from "node:path";
import type { BigIntStats } from "node:fs";
import type { BoundedRegularFileReadResult } from "../files.js";
import { runWindowsBoundedRead } from "./process.js";
import { decodeWindowsReadResult, windowsReadAbortError } from "./result.js";

function isOutsideRoot(rootRelative: string): boolean {
  if (win32.isAbsolute(rootRelative)) return true;
  if (rootRelative === "..") return true;
  return rootRelative.startsWith("..\\");
}

function identity(stats: BigIntStats) {
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
    birthtimeNs: String(stats.birthtimeNs),
  };
}

export async function readWindowsBoundedRegularFile(
  absolutePath: string,
  options: Readonly<{ maxBytes: number; rootPath: string; signal?: AbortSignal }>,
): Promise<BoundedRegularFileReadResult> {
  const relativePath = win32.relative(options.rootPath, absolutePath);
  if (isOutsideRoot(relativePath)) return Object.freeze({ ok: false, reason: "outside_root" });
  if (relativePath === "") return Object.freeze({ ok: false, reason: "not_regular_file" });
  let root: FileHandle | undefined;
  try {
    const canonicalRoot = await realpath(options.rootPath);
    root = await open(canonicalRoot, "r");
    const rootStats = await root.stat({ bigint: true });
    if (!rootStats.isDirectory() || rootStats.ino <= 0n)
      return Object.freeze({ ok: false, reason: "safe_open_unsupported" });
    // Metadata only: all content reads happen through the rooted native handles.
    const targetPath = win32.resolve(canonicalRoot, relativePath);
    const target = await lstat(targetPath, { bigint: true });
    if (!target.isFile()) return Object.freeze({ ok: false, reason: "not_regular_file" });
    const canonicalTarget = await realpath(targetPath);
    if (isOutsideRoot(win32.relative(canonicalRoot, canonicalTarget)))
      return Object.freeze({ ok: false, reason: "outside_root" });
    if (options.signal?.aborted) throw windowsReadAbortError();
    const raw = await runWindowsBoundedRead({
      rootPath: canonicalRoot,
      relativePath: relativePath.split(win32.sep).join("/"),
      rootIdentity: identity(rootStats),
      targetIdentity: identity(target),
      maxBytes: String(options.maxBytes),
    }, options.maxBytes, options.signal);
    if (options.signal?.aborted) throw windowsReadAbortError();
    return decodeWindowsReadResult(raw, options.maxBytes);
  } finally {
    await root?.close();
  }
}
