import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { SchedulerJournalIndex } from "./journal-index.js";
import {
  encodeJournalIndexState,
  parseJournalIndexState,
} from "./journal-index-state.js";
import {
  journalCheckpointName,
  type CommittedJournalHead,
} from "./journal-head.js";
import { journalTransactionName, writeJournalJson } from "./journal-files.js";
import { parseSchedulerTransaction } from "./journal-transaction.js";
import { syncJournalDirectory } from "./journal-durability.js";

export async function loadCheckpointJournalIndex(
  directory: string,
  head: CommittedJournalHead,
) {
  const generationDirectory = join(directory, head.generation);
  const checkpointPath = join(
    generationDirectory,
    "checkpoints",
    head.checkpoint.file,
  );
  const state = parseJournalIndexState(
    JSON.parse(await readFile(checkpointPath, "utf8")),
    generationDirectory,
    head.generation,
    head.checkpoint.sequence,
  );
  const index = new SchedulerJournalIndex(state);
  for (
    let sequence = head.checkpoint.sequence + 1;
    sequence <= head.sequence;
    sequence++
  ) {
    const file = join(generationDirectory, journalTransactionName(sequence));
    index.apply(
      parseSchedulerTransaction(JSON.parse(await readFile(file, "utf8"))),
      file,
    );
  }
  return { index, sequence: head.sequence };
}

export async function writeJournalCheckpoint(
  directory: string,
  generation: string,
  sequence: number,
  index: SchedulerJournalIndex,
): Promise<CommittedJournalHead> {
  const checkpointDirectory = join(directory, generation, "checkpoints");
  await mkdir(checkpointDirectory, { recursive: true, mode: 0o700 });
  await syncJournalDirectory(join(directory, generation));
  const file = journalCheckpointName(sequence);
  const state = encodeJournalIndexState(
    index.exportState(),
    generation,
    sequence,
  );
  parseJournalIndexState(
    state,
    join(directory, generation),
    generation,
    sequence,
  );
  await writeJournalJson(join(checkpointDirectory, file), state);
  return {
    schemaVersion: 3,
    generation,
    sequence,
    checkpoint: { file, sequence },
  };
}

/** Only checkpoint artifacts are retired here; archived transaction payloads remain immutable. */
export async function cleanObsoleteJournalCheckpoints(
  directory: string,
  head: CommittedJournalHead,
): Promise<void> {
  const path = join(directory, head.generation, "checkpoints");
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name === head.checkpoint.file) continue;
    await rm(join(path, entry.name), { force: true });
  }
}
