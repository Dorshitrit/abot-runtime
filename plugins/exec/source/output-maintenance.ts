import { readdir } from "node:fs/promises";

const MAX_CLEANUP_INTERVAL_MS = 60 * 60_000;
type CleanupJob = {
  cleanup: () => Promise<number>;
  intervalMs: number;
  requested: boolean;
};
const jobs = new Map<string, CleanupJob>();

/** One unreferenced job per storage root, retired when the storage is empty. */
export function scheduleExecOutputCleanup(
  root: string,
  retentionMs: number,
  cleanup: () => Promise<number>,
): void {
  const intervalMs = Math.max(
    1,
    Math.min(retentionMs, MAX_CLEANUP_INTERVAL_MS),
  );
  const previous = jobs.get(root);
  if (previous) {
    previous.cleanup = cleanup;
    previous.intervalMs = intervalMs;
    previous.requested = true;
    return;
  }
  const job: CleanupJob = { cleanup, intervalMs, requested: false };
  jobs.set(root, job);
  const sweep = async (): Promise<void> => {
    job.requested = false;
    let empty = false;
    try {
      await job.cleanup();
      empty =
        (
          await readdir(root).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          })
        ).length === 0;
    } catch {
      process.emitWarning(
        "EXEC output cleanup failed; a later sweep will retry.",
        {
          code: "EXEC_OUTPUT_CLEANUP_FAILED",
        },
      );
    }
    if (empty && !job.requested) {
      jobs.delete(root);
      return;
    }
    const timer = setTimeout(() => {
      void sweep();
    }, job.intervalMs);
    timer.unref();
  };
  void sweep();
}
