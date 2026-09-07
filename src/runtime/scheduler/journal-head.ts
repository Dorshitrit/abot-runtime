import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const SCHEDULER_MANIFEST = "scheduler-journal.json";
export const MAX_JOURNAL_SUFFIX = 256;
export const JOURNAL_GENERATION_NAME =
  /^generation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type JournalCheckpointReference = { file: string; sequence: number };
export type JournalHead =
  | { schemaVersion: 2; generation: string }
  | CommittedJournalHead;
export type CommittedJournalHead = {
  schemaVersion: 3;
  generation: string;
  sequence: number;
  checkpoint: JournalCheckpointReference;
};

export async function readJournalHead(
  directory: string,
): Promise<JournalHead | undefined> {
  let text: string;
  try {
    text = await readFile(join(directory, SCHEDULER_MANIFEST), "utf8");
  } catch (error) {
    if (isMissingJournalFile(error)) return undefined;
    throw error;
  }
  return parseJournalHead(JSON.parse(text));
}

function parseJournalHead(value: unknown): JournalHead {
  if (!isJournalObject(value)) corruptJournalHead();
  if (!isJournalGeneration(value.generation)) corruptJournalHead();
  if (value.schemaVersion === 2)
    return { schemaVersion: 2, generation: value.generation };
  if (value.schemaVersion !== 3) corruptJournalHead();
  if (!isJournalSequence(value.sequence)) corruptJournalHead();
  if (!isJournalObject(value.checkpoint)) corruptJournalHead();
  const checkpoint = value.checkpoint;
  if (!isJournalSequence(checkpoint.sequence)) corruptJournalHead();
  if (checkpoint.file !== journalCheckpointName(checkpoint.sequence))
    corruptJournalHead();
  if (!hasBoundedJournalSuffix(value.sequence, checkpoint.sequence))
    corruptJournalHead();
  return {
    schemaVersion: 3,
    generation: value.generation,
    sequence: value.sequence,
    checkpoint: {
      file: String(checkpoint.file),
      sequence: checkpoint.sequence,
    },
  };
}

export function journalReadIdentity(
  head: JournalHead | undefined,
): string | undefined {
  if (!head) return undefined;
  if (head.schemaVersion === 2) return head.generation;
  return `${head.generation}/${head.checkpoint.file}`;
}
export function journalCheckpointName(sequence: number): string {
  if (!isJournalSequence(sequence)) corruptJournalHead();
  return `checkpoint-${sequence}.json`;
}
export function isMissingJournalFile(error: unknown): boolean {
  return isJournalObject(error) && error.code === "ENOENT";
}
function isJournalObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  return !Array.isArray(value);
}
function isJournalGeneration(value: unknown): value is string {
  return typeof value === "string" && JOURNAL_GENERATION_NAME.test(value);
}
function isJournalSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}
function hasBoundedJournalSuffix(sequence: number, covered: number): boolean {
  if (sequence < covered) return false;
  return sequence - covered <= MAX_JOURNAL_SUFFIX;
}
function corruptJournalHead(): never {
  throw new Error("scheduler_store_corrupt");
}
