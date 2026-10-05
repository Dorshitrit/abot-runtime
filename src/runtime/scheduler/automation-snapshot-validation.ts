import type {
  SchedulerAutomationJob,
  SchedulerAutomationRun,
} from "./contracts.js";
import { normalizeStoredSchedulerSchedule, validateTimeZone } from "./schedule-validation.js";

function corruptAutomationSchedulerRecord(): never {
  throw new Error("scheduler_store_corrupt");
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hasOptionalInstant(value: unknown): boolean {
  return value === undefined || hasInstant(value);
}

function hasPositiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function parseStoredAutomationJob(
  value: Record<string, unknown>,
): SchedulerAutomationJob {
  const target = value.target;
  if (!target || typeof target !== "object" || Array.isArray(target))
    corruptAutomationSchedulerRecord();
  const identity = target as Record<string, unknown>;
  if (identity.kind !== "automation") corruptAutomationSchedulerRecord();
  if (!hasText(identity.automationId)) corruptAutomationSchedulerRecord();
  if (!hasPositiveRevision(identity.definitionRevision))
    corruptAutomationSchedulerRecord();
  if (!hasText(value.id) || !hasText(value.environmentId))
    corruptAutomationSchedulerRecord();
  if (!hasText(value.title)) corruptAutomationSchedulerRecord();
  if (typeof value.timeZone !== "string")
    corruptAutomationSchedulerRecord();
  validateTimeZone(value.timeZone);
  if (!hasPositiveRevision(value.revision))
    corruptAutomationSchedulerRecord();
  if (!hasInstant(value.createdAt) || !hasInstant(value.updatedAt))
    corruptAutomationSchedulerRecord();
  if (value.nextRunAt !== null && !hasInstant(value.nextRunAt))
    corruptAutomationSchedulerRecord();
  if (!["active", "paused", "cancelled", "completed"].includes(String(value.state)))
    corruptAutomationSchedulerRecord();
  const schedule = normalizeStoredSchedulerSchedule(
    value.schedule as SchedulerAutomationJob["schedule"],
  );
  if (schedule.kind === "manual" && value.nextRunAt !== null)
    corruptAutomationSchedulerRecord();
  return { ...value, target: identity, schedule } as SchedulerAutomationJob;
}

export function parseStoredAutomationRun(
  value: Record<string, unknown>,
): SchedulerAutomationRun {
  const target = value.target;
  if (!target || typeof target !== "object" || Array.isArray(target))
    corruptAutomationSchedulerRecord();
  const identity = target as Record<string, unknown>;
  if (identity.kind !== "automation") corruptAutomationSchedulerRecord();
  if (!hasText(identity.automationId)) corruptAutomationSchedulerRecord();
  if (!hasPositiveRevision(identity.definitionRevision))
    corruptAutomationSchedulerRecord();
  if (!hasText(value.id) || !hasText(value.jobId))
    corruptAutomationSchedulerRecord();
  if (!hasText(value.environmentId) || !hasText(value.title))
    corruptAutomationSchedulerRecord();
  if (typeof value.timeZone !== "string")
    corruptAutomationSchedulerRecord();
  validateTimeZone(value.timeZone);
  if (!hasPositiveRevision(value.jobRevision))
    corruptAutomationSchedulerRecord();
  if (!hasInstant(value.scheduledAt)) corruptAutomationSchedulerRecord();
  if (!hasOptionalInstant(value.admittedAt)) corruptAutomationSchedulerRecord();
  if (!hasOptionalInstant(value.startedAt) || !hasOptionalInstant(value.finishedAt))
    corruptAutomationSchedulerRecord();
  if (value.trigger !== "manual" && value.trigger !== "schedule")
    corruptAutomationSchedulerRecord();
  if (value.idempotencyKey !== undefined) {
    if (value.trigger !== "manual") corruptAutomationSchedulerRecord();
    if (typeof value.idempotencyKey !== "string")
      corruptAutomationSchedulerRecord();
    if (!value.idempotencyKey || value.idempotencyKey.length > 128)
      corruptAutomationSchedulerRecord();
  }
  if (value.replayOf !== undefined) {
    if (value.trigger !== "manual" || !hasText(value.replayOf) ||
        value.replayOf === value.id)
      corruptAutomationSchedulerRecord();
  }
  if (![
    "pending",
    "running",
    "stopping",
    "succeeded",
    "completed_with_skips",
    "failed",
    "cancelled",
    "interrupted",
    "missed",
  ].includes(String(value.status))) corruptAutomationSchedulerRecord();
  if (value.error !== undefined && typeof value.error !== "string")
    corruptAutomationSchedulerRecord();
  if (value.reportRef !== undefined && !hasText(value.reportRef))
    corruptAutomationSchedulerRecord();
  return value as unknown as SchedulerAutomationRun;
}
