import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SchedulerJob } from "../../scheduler/contracts.js";
import {
  checkpointTransactionPath,
  readCheckpointManifest,
  type CheckpointManifest,
} from "./scheduler-checkpoint-fixture.js";

function canSeedCheckpointJobRevisions(
  head: CheckpointManifest,
  count: number,
): boolean {
  if (head.schemaVersion !== 3) return false;
  if (!head.checkpoint) return false;
  return head.sequence + count - head.checkpoint.sequence <= 256;
}

/** Prepare a closed fixture; acquisition and tested mutations still use real durability. */
export async function seedCheckpointJobRevisions(
  directory: string,
  revisions: readonly SchedulerJob[],
): Promise<void> {
  const head = await readCheckpointManifest(directory);
  if (!canSeedCheckpointJobRevisions(head, revisions.length)) {
    throw new Error(
      "fixture requires a committed checkpoint and bounded suffix",
    );
  }
  // These setup-only writes avoid hundreds of unrelated file/directory fsyncs.
  for (const [offset, job] of revisions.entries()) {
    await writeFile(
      checkpointTransactionPath(
        directory,
        head.generation,
        head.sequence + offset + 1,
      ),
      JSON.stringify({
        version: 1,
        jobs: [job],
        runs: [],
        deletedJobs: [],
        deletedRuns: [],
      }),
    );
  }
  await writeFile(
    join(directory, "scheduler-journal.json"),
    JSON.stringify({ ...head, sequence: head.sequence + revisions.length }),
  );
}
