import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Observe the registered file without following a substituted symbolic link. */
export async function isObservedRegularExecutable(path: string, abortSignal?: AbortSignal): Promise<boolean> {
  abortSignal?.throwIfAborted();
  if (!isAbsolute(path)) return false;
  if (path.length > 4096) return false;
  if (path.includes("\0")) return false;
  try {
    const file = await lstat(path);
    abortSignal?.throwIfAborted();
    if (!file.isFile()) return false;
    if (file.isSymbolicLink()) return false;
    await access(path, constants.X_OK);
    abortSignal?.throwIfAborted();
    return true;
  } catch (error) {
    abortSignal?.throwIfAborted();
    if (isExecutableFileObservationAbort(error)) throw error;
    return false;
  }
}

function isExecutableFileObservationAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError";
}
