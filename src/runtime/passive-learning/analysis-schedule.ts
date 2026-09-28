import { nextSchedulerOccurrence } from "../scheduler/next-occurrence.js";
import { normalizeLearningTrigger } from "./processing-trigger.js";
import type {
  LearningAnalysisWindow,
  PassiveLearningPreferences,
} from "./contracts.js";

const WALL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export function normalizeAnalysisSchedule(
  input: Partial<PassiveLearningPreferences>,
  previous: PassiveLearningPreferences,
): Pick<
  PassiveLearningPreferences,
  "analysisIntervalMinutes" | "analysisTrigger" | "analysisObservationCount" | "analysisWindow" | "maxConcurrentBatches"
> {
  const analysisIntervalMinutes =
    input.analysisIntervalMinutes ?? previous.analysisIntervalMinutes ?? 15;
  const maxConcurrentBatches =
    input.maxConcurrentBatches ?? previous.maxConcurrentBatches ?? 1;
  if (
    !isIntegerInRange(analysisIntervalMinutes, 1, 1440) ||
    !isIntegerInRange(maxConcurrentBatches, 1, 8)
  )
    throw new Error("invalid_learning_preferences");
  const analysisWindow =
    input.analysisWindow === undefined
      ? (previous.analysisWindow ?? null)
      : input.analysisWindow;
  validateWindow(analysisWindow);
  return {
    ...normalizeLearningTrigger(input, previous),
    analysisIntervalMinutes,
    maxConcurrentBatches,
    analysisWindow: analysisWindow
      ? Object.freeze({ ...analysisWindow })
      : null,
  };
}

export function isWithinAnalysisWindow(
  instant: number,
  window?: LearningAnalysisWindow | null,
): boolean {
  if (!window || window.start === window.end) return true;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: window.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const hour = parts.find(({ type }) => type === "hour")!.value;
  const minute = parts.find(({ type }) => type === "minute")!.value;
  const time = `${hour}:${minute}`;
  return window.start < window.end
    ? time >= window.start && time < window.end
    : time >= window.start || time < window.end;
}

/** Missing local start times skip that day, matching the canonical scheduler. */
export function nextAnalysisInstant(
  earliest: number,
  window?: LearningAnalysisWindow | null,
): number {
  if (isWithinAnalysisWindow(earliest, window)) return earliest;
  const next = nextSchedulerOccurrence(
    { kind: "daily", at: window!.start },
    window!.timeZone,
    earliest,
  );
  if (!next) throw new Error("invalid_learning_preferences");
  return Date.parse(next);
}

function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

export function validateWindow(window: LearningAnalysisWindow | null): void {
  if (window === null) return;
  if (
    !window ||
    typeof window !== "object" ||
    !WALL_TIME.test(window.start) ||
    !WALL_TIME.test(window.end) ||
    typeof window.timeZone !== "string"
  )
    throw new Error("invalid_learning_preferences");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: window.timeZone }).format(0);
  } catch {
    throw new Error("invalid_learning_preferences");
  }
}
