import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_SYSTEM_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const activeSystemCaptures = new Set<string>();
const jobs = new Map<string, { retentionMs: number; requested: boolean }>();
const CAPTURE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export async function cleanupSystemOutput(root: string, retentionMs: number): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !CAPTURE_ID.test(entry.name)) continue;
    const directory = join(root, entry.name);
    if (activeSystemCaptures.has(directory)) continue;
    const files = await readdir(directory);
    const times = await Promise.all(files.map(async (file) => (await stat(join(directory, file))).mtimeMs));
    const completedAt = Math.max((await stat(directory)).mtimeMs, ...times);
    const captureRetentionMs = await readCaptureRetention(directory, entry.name, retentionMs);
    if (Date.now() - completedAt < captureRetentionMs) continue;
    if (activeSystemCaptures.has(directory)) continue;
    await rm(directory, { recursive: true });
    removed += 1;
  }
  return removed;
}

/** Completed captures keep the policy recorded by their producer across reconnects. */
async function readCaptureRetention(directory: string, id: string, fallbackMs: number): Promise<number> {
  let receipt: unknown;
  try { receipt = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallbackMs;
    if (error instanceof SyntaxError) return fallbackMs;
    throw error;
  }
  if (receipt === null || typeof receipt !== "object") return fallbackMs;
  if (!("kind" in receipt) || receipt.kind !== "system_command_output_v1") return fallbackMs;
  if (!("id" in receipt) || receipt.id !== id) return fallbackMs;
  if (!("retentionMs" in receipt) || typeof receipt.retentionMs !== "number") return fallbackMs;
  if (!Number.isSafeInteger(receipt.retentionMs) || receipt.retentionMs < 1) return fallbackMs;
  return receipt.retentionMs;
}

/** One cleanup job per storage root; the supplied policy also covers incomplete captures. */
export function scheduleSystemOutputCleanup(root: string, retentionMs: number): void {
  const previous = jobs.get(root);
  if (previous) {
    previous.retentionMs = retentionMs;
    previous.requested = true;
    return;
  }
  const job = { retentionMs, requested: false };
  jobs.set(root, job);
  const sweep = async (): Promise<void> => {
    job.requested = false;
    let empty = false;
    try {
      await cleanupSystemOutput(root, job.retentionMs);
      empty = (await readdir(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })).length === 0;
    } catch {
      process.emitWarning("SYSTEM output cleanup failed; retained output was not confirmed removed.", { code: "SYSTEM_OUTPUT_CLEANUP_FAILED" });
    }
    if (empty && !job.requested) { jobs.delete(root); return; }
    const timer = setTimeout(() => { void sweep(); }, Math.max(1, Math.min(job.retentionMs, 60 * 60_000)));
    timer.unref();
  };
  void sweep();
}
