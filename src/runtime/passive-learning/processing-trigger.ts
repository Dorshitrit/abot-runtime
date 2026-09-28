import type { PassiveLearningPreferences } from "./contracts.js";
import { MAX_PENDING_OBSERVATIONS } from "./queue.js";

export const DEFAULT_ANALYSIS_TRIGGER = "interval";
export const DEFAULT_ANALYSIS_OBSERVATION_COUNT = 100;

/** Count is an admission threshold, not a larger model batch or retention limit. */
export function normalizeLearningTrigger(
  input: Partial<PassiveLearningPreferences>, previous: PassiveLearningPreferences,
): Pick<PassiveLearningPreferences, "analysisTrigger" | "analysisObservationCount"> {
  const analysisTrigger = input.analysisTrigger ?? previous.analysisTrigger ?? DEFAULT_ANALYSIS_TRIGGER;
  const analysisObservationCount = input.analysisObservationCount ?? previous.analysisObservationCount ?? DEFAULT_ANALYSIS_OBSERVATION_COUNT;
  if (!isLearningTriggerMode(analysisTrigger)) throw new Error("invalid_learning_preferences");
  if (!isLearningObservationThreshold(analysisObservationCount)) throw new Error("invalid_learning_preferences");
  return { analysisTrigger, analysisObservationCount };
}

export function isObservationTriggered(preferences: PassiveLearningPreferences): boolean {
  return preferences.analysisTrigger === "observations";
}

export function hasLearningTriggerWork(preferences: PassiveLearningPreferences, eligibleCount: number): boolean {
  if (eligibleCount <= 0) return false;
  if (!isObservationTriggered(preferences)) return true;
  return eligibleCount >= (preferences.analysisObservationCount ?? DEFAULT_ANALYSIS_OBSERVATION_COUNT);
}

function isLearningTriggerMode(value: unknown): boolean {
  return value === "interval" || value === "observations";
}
function isLearningObservationThreshold(value: unknown): boolean {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  return value >= 1 && value <= MAX_PENDING_OBSERVATIONS;
}
