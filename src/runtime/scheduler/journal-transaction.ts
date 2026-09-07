import type {
  SchedulerJob,
  SchedulerRun,
  SchedulerSnapshot,
} from "./contracts.js";
import { parseStoredJob, parseStoredRun } from "./snapshot-validation.js";

export interface SchedulerTransaction {
  version: 1;
  jobs: SchedulerJob[];
  runs: SchedulerRun[];
  deletedJobs: string[];
  deletedRuns: string[];
  jobOrder?: string[];
  runOrder?: string[];
}

export function parseSchedulerTransaction(
  value: unknown,
): SchedulerTransaction {
  if (!isSchedulerTransactionRecord(value))
    throw new Error("scheduler_store_corrupt");
  const raw = value;
  if (!hasSchedulerTransactionCollections(raw))
    throw new Error("scheduler_store_corrupt");
  const transaction: SchedulerTransaction = {
    version: 1,
    jobs: raw.jobs.map(parseStoredJob),
    runs: raw.runs.map(parseStoredRun),
    deletedJobs: requireJournalIds(raw.deletedJobs),
    deletedRuns: requireJournalIds(raw.deletedRuns),
    ...(raw.jobOrder === undefined
      ? {}
      : { jobOrder: requireJournalIds(raw.jobOrder) }),
    ...(raw.runOrder === undefined
      ? {}
      : { runOrder: requireJournalIds(raw.runOrder) }),
  };
  assertJournalTransactionIds(transaction);
  return transaction;
}

function isSchedulerTransactionRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  return !Array.isArray(value);
}

function hasSchedulerTransactionCollections(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { jobs: unknown[]; runs: unknown[] } {
  if (value.version !== 1) return false;
  if (!Array.isArray(value.jobs)) return false;
  return Array.isArray(value.runs);
}

export function assertJournalTransactionIds(
  transaction: SchedulerTransaction,
): void {
  assertDisjointJournalRecords(transaction.jobs, transaction.deletedJobs);
  assertDisjointJournalRecords(transaction.runs, transaction.deletedRuns);
  if (transaction.jobOrder) requireJournalIds(transaction.jobOrder);
  if (transaction.runOrder) requireJournalIds(transaction.runOrder);
}

function assertDisjointJournalRecords(
  records: { id: string }[],
  deleted: string[],
): void {
  const ids = new Set(requireJournalIds(records.map((record) => record.id)));
  if (hasOverlappingJournalIds(ids, requireJournalIds(deleted)))
    throw new Error("scheduler_store_corrupt");
}

function hasOverlappingJournalIds(
  upserted: Set<string>,
  deleted: string[],
): boolean {
  return deleted.some((id) => upserted.has(id));
}

function requireJournalIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("scheduler_store_corrupt");
  if (!hasOnlyJournalIdStrings(value))
    throw new Error("scheduler_store_corrupt");
  if (hasDuplicateJournalIds(value)) throw new Error("scheduler_store_corrupt");
  return [...value];
}

function hasOnlyJournalIdStrings(value: unknown[]): value is string[] {
  return value.every((id) => typeof id === "string");
}

function hasDuplicateJournalIds(value: string[]): boolean {
  return new Set(value).size !== value.length;
}

function changedRecords<T extends { id: string }>(
  before: T[],
  after: T[],
): T[] {
  const originals = new Map(before.map((item) => [item.id, item]));
  return after.filter(
    (item) => JSON.stringify(originals.get(item.id)) !== JSON.stringify(item),
  );
}
function removedRecords(
  before: { id: string }[],
  after: { id: string }[],
): string[] {
  const retained = new Set(after.map((item) => item.id));
  return before.filter((item) => !retained.has(item.id)).map((item) => item.id);
}
export function schedulerTransaction(
  before: SchedulerSnapshot,
  after: SchedulerSnapshot,
  view?: "active",
): SchedulerTransaction {
  const jobOrder = after.jobs.map((item) => item.id);
  const runOrder = after.runs.map((item) => item.id);
  return {
    version: 1,
    jobs: changedRecords(before.jobs, after.jobs),
    runs: changedRecords(before.runs, after.runs),
    deletedJobs: removedRecords(before.jobs, after.jobs),
    deletedRuns: removedRecords(before.runs, after.runs),
    ...(hasJournalOrderChanged(before.jobs, jobOrder) ? { jobOrder } : {}),
    ...(shouldPersistRunOrder(view, before.runs, runOrder) ? { runOrder } : {}),
  };
}

function hasJournalOrderChanged(
  before: { id: string }[],
  order: string[],
): boolean {
  if (before.length !== order.length) return true;
  return before.some((record, index) => record.id !== order[index]);
}

function shouldPersistRunOrder(
  view: "active" | undefined,
  before: SchedulerRun[],
  order: string[],
): boolean {
  if (view === "active") return false;
  return hasJournalOrderChanged(before, order);
}
export function hasSchedulerTransactionChanges(
  value: SchedulerTransaction,
): boolean {
  if (value.jobs.length || value.runs.length) return true;
  if (value.deletedJobs.length || value.deletedRuns.length) return true;
  return value.jobOrder !== undefined || value.runOrder !== undefined;
}
