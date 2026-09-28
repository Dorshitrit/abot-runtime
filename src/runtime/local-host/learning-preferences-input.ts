import type { PassiveLearningPreferences } from "../passive-learning/contracts.js";
import {
  DEFAULT_LEARNING_PREFERENCES,
  normalizeLearningPreferences,
} from "../passive-learning/store.js";

const PREFERENCE_KEYS = [
  "activityPermissions",
  "enabled",
  "processingPaused",
  "modelProfileId",
  "excludedApplications",
  "processingExcludedApplications",
  "analysisIntervalMinutes",
  "analysisTrigger",
  "analysisObservationCount",
  "analysisWindow",
  "maxConcurrentBatches",
  "collectionWindow",
  "proactiveEnabled",
  "proactiveModelProfileId",
  "proactiveIntervalMinutes",
  "proactiveWindow",
  "proactiveMessagesPerDay",
  "maturation",
  "resourceLimits",
] as const satisfies readonly (keyof PassiveLearningPreferences)[];

const NESTED_KEYS: Readonly<Record<string, readonly string[]>> = {
  activityPermissions: ["collection", "learning", "proactive"],
  analysisWindow: ["start", "end", "timeZone"],
  collectionWindow: ["start", "end", "timeZone"],
  proactiveWindow: ["start", "end", "timeZone"],
  maturation: ["promotionScore", "retentionDays", "maxCandidates", "maxBytes"],
  resourceLimits: [
    "modelCallsPerDay",
    "embeddingCallsPerDay",
    "embeddingCharactersPerDay",
    "maxConcurrentCalls",
    "timeZone",
  ],
};

/** Transport shape only; the persisted preferences owner validates all policy values. */
export function readLearningPreferencesInput(
  value: unknown,
): Partial<PassiveLearningPreferences> {
  if (!isPreferenceObject(value))
    throw new Error("passive_learning_preferences_invalid");
  for (const [key, input] of Object.entries(value)) {
    if (!(PREFERENCE_KEYS as readonly string[]).includes(key))
      throw new Error("passive_learning_preferences_invalid");
    if (input === undefined) continue;
    if (input === null && !isClearedLearningPreference(key, input))
      throw new Error("passive_learning_preferences_invalid");
    if (!NESTED_KEYS[key] || input === null) continue;
    if (!isPreferenceObject(input))
      throw new Error("passive_learning_preferences_invalid");
    if (Object.keys(input).some((field) => !NESTED_KEYS[key].includes(field)))
      throw new Error("passive_learning_preferences_invalid");
    if (NESTED_KEYS[key].some((field) => input[field] === undefined))
      throw new Error("passive_learning_preferences_invalid");
  }
  const normalized = normalizeLearningPreferences(
    value,
    DEFAULT_LEARNING_PREFERENCES,
  );
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, isClearedLearningPreference(key, value[key])
        ? null : normalized[key as keyof PassiveLearningPreferences]]),
  );
}

function isClearedLearningPreference(key: string, value: unknown): boolean {
  if (value !== null) return false;
  return ["analysisWindow", "collectionWindow", "proactiveWindow", "proactiveModelProfileId"].includes(key);
}

function isPreferenceObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  return !Array.isArray(value);
}
