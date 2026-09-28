import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export function hostStateDirectory(rootDir: string): string {
  return join(rootDir, ".runtime", "system-host");
}
export function ensureHostStateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory()) throw new Error("host_state_directory_invalid");
  if (process.platform === "win32") return;
  if (stat.uid !== process.getuid?.())
    throw new Error("host_state_owner_invalid");
  if ((stat.mode & 0o077) !== 0)
    throw new Error("host_state_directory_not_private");
}
export function readHostPrivateJson(path: string): unknown | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error("host_state_file_invalid");
    if (process.platform !== "win32") {
      if (stat.uid !== process.getuid?.())
        throw new Error("host_state_owner_invalid");
      if ((stat.mode & 0o077) !== 0)
        throw new Error("host_state_file_not_private");
    }
    if (stat.size > 16_384) throw new Error("host_state_file_too_large");
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export function writeHostPrivateJson(path: string, value: unknown): void {
  ensureHostStateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
