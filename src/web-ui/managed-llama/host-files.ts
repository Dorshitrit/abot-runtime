import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { requireValue } from "./contracts.js";
import { verifyWindowsLlamaStorage } from "./windows-storage.js";

function storageCheck(value: unknown): asserts value {
  requireValue(value, "invalid_installation", "Expected canonical private managed storage.");
}
export function isLocalModelPath(path: string, os: string = process.platform): boolean {
  if (os !== "win32") return path.startsWith("/");
  if (!/^[A-Za-z]:[\\/]/u.test(path)) return false;
  return path.slice(3).split(/[\\/]/u).every(part => part.length > 0 && !/[<>:"|?*\u0000-\u001f\u007f]/u.test(part)
    && !/[. ]$/u.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}
export function privatePosixMode(stat: Stats, mode?: number): boolean {
  if (typeof process.getuid !== "function" || stat.uid !== process.getuid()) return false;
  if (mode !== undefined) return (stat.mode & 0o777) === mode;
  return (stat.mode & 0o077) === 0;
}
export async function canonicalManagedDirectory(path: string, privateDirectory = false): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await canonicalManagedDirectory(parent);
  const stat = await lstat(path);
  storageCheck(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(path) === path);
  if (!privateDirectory) return;
  if (process.platform === "win32") { await verifyWindowsLlamaStorage(path); return; }
  storageCheck(privatePosixMode(stat));
}
export async function createPrivateManagedDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  try { await claimCreatedManagedPath(path, true); }
  catch (error) { await rmdir(path).catch(() => {}); throw error; }
}
export async function claimCreatedManagedPath(path: string, directory = false): Promise<void> {
  if (process.platform === "win32") await verifyWindowsLlamaStorage(path, directory ? "create-directory" : "create-file");
}
export async function verifyPrivateManagedFile(path: string, stat: Stats, mode?: number): Promise<void> {
  storageCheck(stat.isFile());
  if (process.platform === "win32") { await verifyWindowsLlamaStorage(path); return; }
  storageCheck(privatePosixMode(stat, mode));
}
/** Node has no Windows O_NOFOLLOW. Validate canonical paths before opening and
 * bind lstat/fstat identity. Private ancestors exclude other users; hostile
 * same-user replacement remains outside this module's path-API contract. */
export async function openManagedRead(path: string) {
  await canonicalManagedDirectory(dirname(path));
  if (process.platform === "win32") {
    storageCheck(isLocalModelPath(path));
    await verifyWindowsLlamaStorage(path, "path");
  }
  const before = await lstat(path);
  storageCheck(before.isFile() && !before.isSymbolicLink() && await realpath(path) === path);
  const flags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const file = await open(path, flags);
  try {
    const after = await file.stat();
    storageCheck(after.isFile() && after.ino === before.ino && after.dev === before.dev);
    return file;
  } catch (error) { await file.close(); throw error; }
}
export async function createManagedFile(path: string) {
  await canonicalManagedDirectory(dirname(path));
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  const file = await open(path, process.platform === "win32" ? flags : flags | constants.O_NOFOLLOW, 0o600);
  try { await claimCreatedManagedPath(path); return file; }
  catch (error) { await file.close(); await unlink(path).catch(() => {}); throw error; }
}
export async function syncManagedDirectory(path: string): Promise<void> {
  // Same platform contract as durable session commits: synced file + atomic
  // replacement on Windows; Node does not provide Windows directory fsync.
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { storageCheck((await handle.stat()).isDirectory()); await handle.sync(); }
  finally { await handle.close(); }
}
