import type {
  SchedulerJob,
  SchedulerRun,
  SchedulerSnapshot,
} from "./contracts.js";
import {
  normalizeStoredSchedulerSchedule,
  validateSchedulerJobInput,
  validateTimeZone,
} from "./schedule-validation.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  return !Array.isArray(value);
}
function failSnapshot(): never {
  throw new Error("scheduler_store_corrupt");
}
function requireSnapshotInstant(value: unknown): void {
  if (typeof value !== "string") failSnapshot();
  if (!Number.isFinite(Date.parse(value))) failSnapshot();
}
export function parseStoredJob(value: unknown): SchedulerJob {
  if (!isRecord(value)) failSnapshot();
  const job = value as unknown as SchedulerJob;
  validateSchedulerJobInput(job);
  if (!job.id || !job.environmentId) failSnapshot();
  if (job.toolPermissionMode !== "full_access") failSnapshot();
  if (!["active", "paused", "cancelled", "completed"].includes(job.state))
    failSnapshot();
  if (!Number.isSafeInteger(job.revision)) failSnapshot();
  requireSnapshotInstant(job.createdAt);
  requireSnapshotInstant(job.updatedAt);
  if (job.nextRunAt !== null) requireSnapshotInstant(job.nextRunAt);
  // Canonical storage must not silently synthesize a missing timer/interval anchor.
  if (job.schedule?.kind === "timer" && !job.schedule.at) failSnapshot();
  if (job.schedule?.kind === "interval" && !job.schedule.anchorAt)
    failSnapshot();
  const normalized = normalizeStoredSchedulerSchedule(job.schedule);
  return { ...job, schedule: normalized };
}
export function parseStoredRun(value: unknown): SchedulerRun {
  if (!isRecord(value)) failSnapshot();
  for (const field of [
    "id",
    "jobId",
    "environmentId",
    "sessionId",
    "requestId",
    "title",
    "prompt",
    "modelProfileId",
    "timeZone",
  ]) {
    if (typeof value[field] !== "string") failSnapshot();
  }
  if (!["fast", "reasoning", "deep"].includes(String(value.agentMode)))
    failSnapshot();
  if (!Number.isSafeInteger(value.jobRevision)) failSnapshot();
  if (Number(value.jobRevision) < 1) failSnapshot();
  validateTimeZone(String(value.timeZone));
  const states = [
    "pending",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
    "missed",
  ];
  if (!states.includes(String(value.status))) failSnapshot();
  if (!["schedule", "manual"].includes(String(value.trigger))) failSnapshot();
  requireSnapshotInstant(value.scheduledAt);
  if (value.startedAt !== undefined) requireSnapshotInstant(value.startedAt);
  if (value.finishedAt !== undefined) requireSnapshotInstant(value.finishedAt);
  return value as unknown as SchedulerRun;
}
export function parseSchedulerSnapshot(value: unknown): SchedulerSnapshot {
  if (!isRecord(value)) failSnapshot();
  if (value.schemaVersion !== 1) failSnapshot();
  if (!Array.isArray(value.jobs)) failSnapshot();
  if (!Array.isArray(value.runs)) failSnapshot();
  const jobs = value.jobs.map(parseStoredJob);
  const runs = value.runs.map(parseStoredRun);
  if (new Set(jobs.map((job) => job.id)).size !== jobs.length) failSnapshot();
  if (new Set(runs.map((run) => run.id)).size !== runs.length) failSnapshot();
  for (const run of runs) {
    const owner = jobs.find((job) => job.id === run.jobId);
    if (!owner) failSnapshot();
    if (owner.sessionId !== run.sessionId) failSnapshot();
    if (owner.environmentId !== run.environmentId) failSnapshot();
    if (run.jobRevision > owner.revision) failSnapshot();
  }
  return { schemaVersion: 1, jobs, runs };
}
