import { lstat } from "node:fs/promises";

export function isWindowsLockObservationDenial(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "EPERM";
}

function isMissingLockObservation(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ENOENT";
}

/** Normalize only a freshly confirmed disappearance; never accept opaque locks. */
export async function rethrowLockObservationError(
  path: string,
  error: unknown,
): Promise<never> {
  if (!isWindowsLockObservationDenial(error)) throw error;
  try {
    await lstat(path);
  } catch (observationError) {
    if (isMissingLockObservation(observationError)) throw observationError;
  }
  throw error;
}
