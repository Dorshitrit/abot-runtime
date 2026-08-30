import { acquireFileLock } from "./file-lock/acquisition.js";
import type { FileLockOptions } from "./file-lock/contracts.js";

export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const release = await acquireFileLock(lockPath, options);
  try {
    return await operation();
  } finally {
    await release();
  }
}
