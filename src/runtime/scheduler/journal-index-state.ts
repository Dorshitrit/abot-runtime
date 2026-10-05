import { basename, join } from "node:path";
import type { SchedulerStoredJob, SchedulerStoredRun } from "./contracts.js";
import {
  isAutomationSchedulerJob,
  isAutomationSchedulerRun,
} from "./scheduler-target.js";
import { parseStoredJob, parseStoredRun } from "./snapshot-validation.js";
import {
  emptyAutomationIndexState,
  encodeAutomationIndexState,
  parseAutomationIndexState,
  type JournalAutomationIndexState,
} from "./journal-automation-index.js";

export type JournalRunEntry = Pick<
  SchedulerStoredRun,
  | "id"
  | "jobId"
  | "environmentId"
  | "jobRevision"
  | "scheduledAt"
  | "status"
> & {
  target?: SchedulerStoredRun["target"];
  sessionId?: string;
  requestId?: string;
  idempotencyKey?: string;
  admittedAt?: string;
  file: string;
  offset: number;
  active?: SchedulerStoredRun;
};
export type JournalIndexState = {
  jobs: SchedulerStoredJob[];
  runs: JournalRunEntry[];
  automations: JournalAutomationIndexState;
};

export function encodeJournalIndexState(
  state: JournalIndexState,
  generation: string,
  sequence: number,
) {
  return {
    version: 2,
    generation,
    sequence,
    jobs: state.jobs,
    runs: state.runs.map((entry) => ({ ...entry, file: basename(entry.file) })),
    automations: encodeAutomationIndexState(state.automations),
  };
}

export function parseJournalIndexState(
  value: unknown,
  directory: string,
  generation: string,
  sequence: number,
): JournalIndexState {
  if (!isIndexObject(value)) corruptJournalIndex();
  if (value.version !== 1 && value.version !== 2) corruptJournalIndex();
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
  const automations =
    value.version === 1
      ? emptyAutomationIndexState()
      : parseAutomationIndexState(value.automations, directory, sequence);
  return { jobs, runs, automations };
}

function parseJournalRunEntry(
  value: unknown,
  directory: string,
  sequence: number,
  jobs: Map<string, SchedulerStoredJob>,
): JournalRunEntry {
  if (!isIndexObject(value)) corruptJournalIndex();
  for (const field of ["id", "jobId", "environmentId", "scheduledAt"]) {
    if (typeof value[field] !== "string") corruptJournalIndex();
  }
  if (!hasIndexedRunTarget(value)) corruptJournalIndex();
  if (value.idempotencyKey !== undefined) {
    if (value.target === undefined || !isIndexObject(value.target))
      corruptJournalIndex();
    if (value.target.kind !== "automation") corruptJournalIndex();
    if (!isValidIdempotencyKey(value.idempotencyKey)) corruptJournalIndex();
  }
  if (!Number.isFinite(Date.parse(String(value.scheduledAt))))
    corruptJournalIndex();
  if (value.admittedAt !== undefined) {
    if (!isIndexObject(value.target) || value.target.kind !== "automation" ||
        typeof value.admittedAt !== "string" ||
        !Number.isFinite(Date.parse(value.admittedAt)))
      corruptJournalIndex();
  }
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
  run: SchedulerStoredRun | undefined,
  entry: JournalRunEntry,
): run is SchedulerStoredRun {
  if (!run) return false;
  const fields = [
    "id",
    "jobId",
    "environmentId",
    "jobRevision",
    "scheduledAt",
    "status",
  ] as const;
  if (!fields.every((field) => run[field] === entry[field])) return false;
  if (isAutomationSchedulerRun(run)) {
    if (entry.target?.kind !== "automation") return false;
    if (run.target.automationId !== entry.target.automationId) return false;
    return run.target.definitionRevision === entry.target.definitionRevision &&
      run.idempotencyKey === entry.idempotencyKey &&
      run.admittedAt === entry.admittedAt;
  }
  if (entry.target?.kind === "automation") return false;
  return run.sessionId === entry.sessionId && run.requestId === entry.requestId;
}
function requireIndexedRunOwner(
  entry: JournalRunEntry,
  job: SchedulerStoredJob | undefined,
): void {
  if (!job) corruptJournalIndex();
  if (entry.environmentId !== job.environmentId) corruptJournalIndex();
  if (entry.jobRevision > job.revision) corruptJournalIndex();
  if (isAutomationSchedulerJob(job)) {
    if (entry.target?.kind !== "automation") corruptJournalIndex();
    if (entry.target.automationId !== job.target.automationId)
      corruptJournalIndex();
    if (entry.target.definitionRevision > job.target.definitionRevision)
      corruptJournalIndex();
    return;
  }
  if (entry.target?.kind === "automation") corruptJournalIndex();
  if (entry.sessionId !== job.sessionId) corruptJournalIndex();
}
function hasIndexedRunTarget(value: Record<string, unknown>): boolean {
  if (value.target === undefined) {
    return typeof value.sessionId === "string" && typeof value.requestId === "string";
  }
  if (!isIndexObject(value.target)) return false;
  if (value.target.kind === "request") {
    return typeof value.sessionId === "string" && typeof value.requestId === "string";
  }
  if (value.target.kind !== "automation") return false;
  if (typeof value.target.automationId !== "string") return false;
  if (!isPositiveIndexInteger(value.target.definitionRevision)) return false;
  return value.sessionId === undefined && value.requestId === undefined;
}
function isIndexObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  return !Array.isArray(value);
}
function isPositiveIndexInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}
function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
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
function isIndexedRunStatus(value: unknown): value is SchedulerStoredRun["status"] {
  if (typeof value !== "string") return false;
  return [
    "pending",
    "running",
    "stopping",
    "succeeded",
    "completed_with_skips",
    "failed",
    "cancelled",
    "interrupted",
    "missed",
  ].includes(value);
}
function requiresActiveRunPayload(status: SchedulerStoredRun["status"]): boolean {
  return status === "pending" || status === "running" || status === "stopping";
}
function corruptJournalIndex(): never {
  throw new Error("scheduler_store_corrupt");
}
