import { textOf } from "./text-format.js";

export function normalizeScheduleReference(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const jobId = textOf(raw.jobId).trim();
  const runId = textOf(raw.runId).trim();
  if (!jobId || !runId) return undefined;
  return {
    jobId,
    runId,
    title: textOf(raw.title).trim() || "Scheduled task",
    scheduledAt: textOf(raw.scheduledAt),
    triggerType: textOf(raw.triggerType),
  };
}

export function scheduleTimeLabel(value, timeZone) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    return date.toISOString();
  }
}
