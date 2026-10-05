import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExecOutputOwnerRecord } from "./output-contracts.js";

/** Old or interrupted captures may lack a closed timestamp. Reads do not renew TTL. */
export async function outputCaptureCompletedAt(
  directory: string,
  owner?: ExecOutputOwnerRecord,
): Promise<number> {
  if (owner?.completedAt !== null && owner?.completedAt !== undefined)
    return owner.completedAt;
  const entries = await readdir(directory, { withFileTypes: true });
  const captures = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".bytes"),
  );
  if (!captures.length) return (await stat(directory)).mtimeMs;
  const times = await Promise.all(
    captures.map(
      async (entry) => (await stat(join(directory, entry.name))).mtimeMs,
    ),
  );
  return Math.max(...times);
}

export async function hasOutputExpired(
  directory: string,
  owner: ExecOutputOwnerRecord | undefined,
  now: number,
  retentionMs: number,
): Promise<boolean> {
  return (
    now - (await outputCaptureCompletedAt(directory, owner)) >= retentionMs
  );
}
