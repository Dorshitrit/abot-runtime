import { rename } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const WINDOWS_REPLACEMENT_WAIT_MS = 1_000;
const WINDOWS_REPLACEMENT_DELAY_MS = 25;
const MAX_REPLACEMENT_ATTEMPTS = 41;

function isRetryableWindowsReplacementError(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  if (error === null || typeof error !== "object") return false;
  return "code" in error && error.code === "EPERM";
}

function canWaitForSessionReplacement(attempts: number, deadline: number): boolean {
  if (attempts >= MAX_REPLACEMENT_ATTEMPTS) return false;
  return performance.now() < deadline;
}

/**
 * Windows replacement can be denied while another reader holds the destination.
 * EPERM can also be permanent: bounded failure retains the latest filesystem error.
 * Only retry publication of this prepared file; callers retain cleanup and durability.
 */
export async function replacePreparedSessionFile(
  temporary: string,
  target: string,
  assertCurrent?: () => void,
): Promise<void> {
  const deadline = performance.now() + WINDOWS_REPLACEMENT_WAIT_MS;
  let attempts = 0;
  for (;;) {
    // A guard failure is never a filesystem contention error, even if coded EPERM.
    assertCurrent?.();
    attempts += 1;
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      if (!isRetryableWindowsReplacementError(error)) throw error;
      if (!canWaitForSessionReplacement(attempts, deadline)) throw error;
      const delayMs = Math.min(WINDOWS_REPLACEMENT_DELAY_MS, deadline - performance.now());
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
      // Timer scheduling can run late. Do not begin another attempt beyond the bound.
      if (performance.now() >= deadline) throw error;
    }
  }
}
