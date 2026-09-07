import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { SchedulerJournalIndex } from "./journal-index.js";
import {
  parseSchedulerTransaction,
  type SchedulerTransaction,
} from "./journal-transaction.js";
import { JOURNAL_GENERATION_NAME, readJournalHead } from "./journal-head.js";
import { syncJournalDirectory } from "./journal-durability.js";

export { SCHEDULER_MANIFEST, isMissingJournalFile } from "./journal-head.js";
export { writeJournalJson } from "./journal-durability.js";
export async function readJournalGeneration(
  directory: string,
): Promise<string | undefined> {
  return (await readJournalHead(directory))?.generation;
}
export async function loadJournalIndex(directory: string, generation: string) {
  const path = join(directory, generation);
  const entries = (await readdir(path))
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (!entries.length) throw new Error("scheduler_store_corrupt");
  const index = new SchedulerJournalIndex();
  for (const [position, name] of entries.entries()) {
    if (name !== journalTransactionName(position + 1))
      throw new Error("scheduler_store_corrupt");
    const file = join(path, name);
    index.apply(
      parseSchedulerTransaction(JSON.parse(await readFile(file, "utf8"))),
      file,
    );
  }
  return { index, sequence: entries.length };
}
export function journalTransactionName(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new Error("scheduler_store_sequence_invalid");
  return `${String(sequence).padStart(16, "0")}.json`;
}
export async function createJournalGeneration(
  directory: string,
): Promise<string> {
  const generation = `generation-${randomUUID()}`;
  await mkdir(join(directory, generation), { mode: 0o700 });
  await syncJournalDirectory(directory);
  return generation;
}
/** Only under the owner lock. The committed pointer is the sole keep rule. */
export async function cleanObsoleteJournalGenerations(
  directory: string,
  active?: string,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!isJournalGenerationDirectory(entry)) continue;
    if (entry.name === active) continue;
    await rm(join(directory, entry.name), { recursive: true, force: true });
  }
  if (active) await rm(join(directory, "scheduler.json"), { force: true });
}
function isJournalGenerationDirectory(entry: {
  name: string;
  isDirectory(): boolean;
}): boolean {
  if (!entry.isDirectory()) return false;
  return JOURNAL_GENERATION_NAME.test(entry.name);
}
export function initialJournalTransaction(): SchedulerTransaction {
  return { version: 1, jobs: [], runs: [], deletedJobs: [], deletedRuns: [] };
}
