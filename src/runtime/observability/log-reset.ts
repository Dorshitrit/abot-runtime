import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isOwnedRotatedLogName } from "./log-rotation.js";
export type RuntimeLogsResetResult = Readonly<{
  complete: true;
  clearedFiles: number;
  removedRotatedFiles: number;
}>;

function isMissingLog(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function samePhysicalPath(left: string, right: string): boolean {
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function isWithinDirectory(directory: string, path: string): boolean {
  const subpath = relative(resolve(directory), resolve(path));
  if (subpath === "") return true;
  if (isAbsolute(subpath)) return false;
  return subpath !== ".." && !subpath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

async function physicalDirectory(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!isMissingLog(error)) throw error;
    const absolute = resolve(path);
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(await physicalDirectory(parent), basename(absolute));
  }
}

async function requireOrdinaryLogFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1)
      throw new Error("runtime_log_reset_unsafe_path");
    return true;
  } catch (error) {
    if (isMissingLog(error)) return false;
    throw error;
  }
}

/** Clears only the configured trace family; caller serializes it with owned writes. */
export async function clearRuntimeTraceFiles(traceFile: string, sharedDir: string): Promise<RuntimeLogsResetResult> {
  const active = resolve(traceFile);
  if (isWithinDirectory(await physicalDirectory(sharedDir), active)) throw new Error("runtime_maintenance_shared_paths");
  const directory = dirname(active);
  let resolvedDirectory: string;
  try { resolvedDirectory = await realpath(directory); }
  catch (error) {
    if (isMissingLog(error)) return { complete: true, clearedFiles: 0, removedRotatedFiles: 0 };
    throw error;
  }
  if (!samePhysicalPath(directory, resolvedDirectory)) throw new Error("runtime_log_reset_unsafe_path");
  const rotations = (await readdir(directory)).filter(name => isOwnedRotatedLogName(active, name))
    .map(name => join(directory, name));
  const present = await requireOrdinaryLogFile(active);
  // Validate the entire selected family before the first destructive operation.
  for (const path of rotations) await requireOrdinaryLogFile(path);
  let removedRotatedFiles = 0;
  for (const path of rotations) {
    try { await unlink(path); removedRotatedFiles += 1; }
    catch (error) { if (!isMissingLog(error)) throw error; }
  }
  if (present) {
    const handle = await open(active, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.nlink > 1) throw new Error("runtime_log_reset_unsafe_path");
      await handle.truncate(0);
    } finally { await handle.close(); }
  }
  return { complete: true, clearedFiles: removedRotatedFiles + Number(present), removedRotatedFiles };
}
