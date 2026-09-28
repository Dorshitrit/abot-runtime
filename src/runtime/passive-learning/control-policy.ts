import type { PassiveLearningPreferences } from "./contracts.js";
import type { LearningBackgroundDependencies } from "./background-dependencies.js";
import type { PassiveCollectionState } from "../../shared/passive-observation.js";

export function canRestartPermissionBlockedCollection(
  collectionAllowed: boolean,
  state: "off" | PassiveCollectionState,
): boolean {
  if (!collectionAllowed) return false;
  return state === "permission_required";
}

export function requiresLearningAvailability(
  previous: PassiveLearningPreferences,
  next: PassiveLearningPreferences,
  availabilityFailed = false,
  input: Partial<PassiveLearningPreferences> = {},
): boolean {
  if (next.processingPaused) return false;
  if (!next.modelProfileId) return false;
  if (availabilityFailed && requestsLearningProcessingUpdate(input)) return true;
  if (previous.processingPaused) return true;
  return next.modelProfileId !== previous.modelProfileId;
}

function requestsLearningProcessingUpdate(input: Partial<PassiveLearningPreferences>): boolean {
  const keys = ["processingPaused", "modelProfileId", "analysisIntervalMinutes", "analysisWindow",
    "analysisTrigger", "analysisObservationCount",
    "maxConcurrentBatches", "processingExcludedApplications", "maturation", "resourceLimits"] as const;
  return keys.some((key) => input[key] !== undefined);
}

export function hasLearningMemoryWriter(background: LearningBackgroundDependencies): boolean {
  if (background.memory.learning && background.model.review) return true;
  return typeof background.memory.saveObservationBatch === "function";
}

export function requiresCollectionConnection(
  previous: PassiveLearningPreferences,
  next: PassiveLearningPreferences,
): boolean {
  if (!next.enabled) return false;
  if (!previous.enabled) return true;
  return (
    JSON.stringify(previous.excludedApplications) !==
    JSON.stringify(next.excludedApplications)
  );
}

export function hasAnalysisScheduleChanged(
  previous: PassiveLearningPreferences,
  next: PassiveLearningPreferences,
): boolean {
  if (previous.analysisTrigger !== next.analysisTrigger) return true;
  if (previous.analysisObservationCount !== next.analysisObservationCount) return true;
  if (previous.analysisIntervalMinutes !== next.analysisIntervalMinutes)
    return true;
  return (
    JSON.stringify(previous.analysisWindow) !==
    JSON.stringify(next.analysisWindow)
  );
}

export function hasLearningProcessingConfigurationChanged(
  previous: PassiveLearningPreferences, next: PassiveLearningPreferences,
): boolean {
  if (hasAnalysisScheduleChanged(previous, next)) return true;
  const keys = ["modelProfileId", "processingPaused", "maxConcurrentBatches",
    "processingExcludedApplications", "resourceLimits", "maturation"] as const;
  return keys.some((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
}
