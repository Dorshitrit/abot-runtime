import { basename, join } from "node:path";
import type { SchedulerJob, SchedulerRun } from "./contracts.js";
import { parseStoredJob, parseStoredRun } from "./snapshot-validation.js";

export type JournalRunEntry = Pick<
  SchedulerRun,
  | "id"
  | "jobId"
  | "sessionId"
  | "environmentId"
  | "jobRevision"
  | "scheduledAt"
  | "requestId"
  | "status"
> & { file: string; offset: number; active?: SchedulerRun };
export type JournalIndexState = {
  jobs: SchedulerJob[];
  runs: JournalRunEntry[];
};

export function encodeJournalIndexState(
  state: JournalIndexState,
  generation: string,
  sequence: number,
) {
  return {
    version: 1,
    generation,
    sequence,
    jobs: state.jobs,
    runs: state.runs.map((entry) => ({ ...entry, file: basename(entry.file) })),
  };
}

export function parseJournalIndexState(
  value: unknown,
  directory: string,
  generation: string,
  sequence: number,
): JournalIndexState {
  if (!isIndexObject(value)) corruptJournalIndex();
  if (value.version !== 1) corruptJournalIndex();
  if (value.generation !== generation) corruptJournalIndex();
  if (value.sequence !== sequence) corruptJournalIndex();
  if (!Array.isArray(value.jobs)) corruptJournalIndex();
  if (!Array.isArray(value.runs)) corruptJournalIndex();
  const jobs = value.jobs.map(parseStoredJob);
  const owners = new Map(jobs.map((job) => [job.id, job]));
  if (owners.size !== jobs.length) corruptJournalIndex();
  const runs = value.runs.map((entry) =>
    parseJournalRunEntry(entry, directory, sequence, owners),
  );
  if (new Set(runs.map((entry) => entry.id)).size !== runs.length)
    corruptJournalIndex();
  return { jobs, runs };
}

function parseJournalRunEntry(
  value: unknown,
  directory: string,
  sequence: number,
  jobs: Map<string, SchedulerJob>,
): JournalRunEntry {
  if (!isIndexObject(value)) corruptJournalIndex();
  for (const field of [
    "id",
    "jobId",
    "sessionId",
    "environmentId",
    "requestId",
    "scheduledAt",
  ]) {
    if (typeof value[field] !== "string") corruptJournalIndex();
  }
  if (!Number.isFinite(Date.parse(String(value.scheduledAt))))
    corruptJournalIndex();
  if (!isPositiveIndexInteger(value.jobRevision)) corruptJournalIndex();
  if (!isNonnegativeIndexInteger(value.offset)) corruptJournalIndex();
  if (!isCoveredTransactionFile(value.file, sequence)) corruptJournalIndex();
  if (!isIndexedRunStatus(value.status)) corruptJournalIndex();
  const entry = {
    ...value,
    file: join(directory, value.file),
  } as JournalRunEntry;
  requireIndexedRunOwner(entry, jobs.get(entry.jobId));
  if (requiresActiveRunPayload(entry.status)) {
    entry.active = parseStoredRun(value.active);
    if (!matchesIndexedJournalRun(entry.active, entry)) corruptJournalIndex();
    return entry;
  }
  if (value.active !== undefined) corruptJournalIndex();
  return entry;
}

export function matchesIndexedJournalRun(
  run: SchedulerRun | undefined,
  entry: JournalRunEntry,
): run is SchedulerRun {
  if (!run) return false;
  const fields = [
    "id",
    "jobId",
    "sessionId",
    "environmentId",
    "jobRevision",
    "scheduledAt",
    "requestId",
    "status",
  ] as const;
  return fields.every((field) => run[field] === entry[field]);
}
function requireIndexedRunOwner(
  entry: JournalRunEntry,
  job: SchedulerJob | undefined,
): void {
  if (!job) corruptJournalIndex();
  if (entry.sessionId !== job.sessionId) corruptJournalIndex();
  if (entry.environmentId !== job.environmentId) corruptJournalIndex();
  if (entry.jobRevision > job.revision) corruptJournalIndex();
}
function isIndexObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  return !Array.isArray(value);
}
function isPositiveIndexInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}
function isNonnegativeIndexInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function isCoveredTransactionFile(
  value: unknown,
  sequence: number,
): value is string {
  if (typeof value !== "string") return false;
  if (!/^[0-9]{16}\.json$/.test(value)) return false;
  const reference = Number(value.slice(0, -5));
  if (!isPositiveIndexInteger(reference)) return false;
  return reference <= sequence;
}
function isIndexedRunStatus(value: unknown): value is SchedulerRun["status"] {
  if (typeof value !== "string") return false;
  return [
    "pending",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
    "missed",
  ].includes(value);
}
function requiresActiveRunPayload(status: SchedulerRun["status"]): boolean {
  return status === "pending" || status === "running";
}
function corruptJournalIndex(): never {
  throw new Error("scheduler_store_corrupt");
}
