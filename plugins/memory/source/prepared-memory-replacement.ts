import { rename } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const WINDOWS_REPLACEMENT_WAIT_MS = 1_000;
const WINDOWS_REPLACEMENT_DELAY_MS = 25;
const MAX_REPLACEMENT_ATTEMPTS = 41;

function isRetryableWindowsMemoryReplacementError(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  if (error === null || typeof error !== "object") return false;
  return "code" in error && error.code === "EPERM";
}

function canWaitForMemoryReplacement(attempts: number, deadline: number): boolean {
  if (attempts >= MAX_REPLACEMENT_ATTEMPTS) return false;
  return performance.now() < deadline;
}

/**
 * Readers can temporarily deny Windows replacement. Permanent EPERM stays an error.
 * The caller keeps the mutation lock and owns cleanup; never rerun the mutation.
 */
export async function replacePreparedMemoryFile(temporary: string, target: string): Promise<void> {
  const deadline = performance.now() + WINDOWS_REPLACEMENT_WAIT_MS;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      if (!isRetryableWindowsMemoryReplacementError(error)) throw error;
      if (!canWaitForMemoryReplacement(attempts, deadline)) throw error;
      const delayMs = Math.min(WINDOWS_REPLACEMENT_DELAY_MS, deadline - performance.now());
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
      // A late timer must not start another attempt beyond the monotonic deadline.
      if (performance.now() >= deadline) throw error;
    }
  }
}
