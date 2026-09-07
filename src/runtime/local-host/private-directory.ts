import { lstat, mkdir, mkdtemp, rename, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertPrivateRuntimeAccess } from "./private-access.js";
import { verifyWindowsPrivateAccess } from "./windows-private-access.js";

export async function ensurePrivateRuntimeDirectory(
  directory: string,
): Promise<void> {
  if (process.platform === "win32")
    await installWindowsPrivateDirectory(directory);
  else await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("local_runtime_directory_not_private");
  await assertPrivateRuntimeAccess(
    directory,
    stat,
    "local_runtime_directory_not_private",
  );
}

async function installWindowsPrivateDirectory(
  directory: string,
): Promise<void> {
  if (await hasExistingPath(directory)) return;
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(
    join(parent, `.${basename(directory)}.private-`),
  );
  try {
    await verifyWindowsPrivateAccess(temporary, true);
    try {
      await rename(temporary, directory);
    } catch (error) {
      if (!(await hasExistingPath(directory))) throw error;
      // A concurrent creator won; the caller verifies its installed ACL below.
    }
  } catch {
    throw new Error("local_runtime_directory_not_private");
  } finally {
    await rmdir(temporary).catch((error) => {
      if (!isMissingPath(error)) throw error;
    });
  }
}

async function hasExistingPath(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ENOENT";
}
