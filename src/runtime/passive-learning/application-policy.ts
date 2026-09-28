import type { LearningBatch, LearningObservation, PassiveLearningPreferences } from "./contracts.js";

export function learningApplicationKey(app: string): string { return app.trim().toLowerCase(); }

export function isLearningApplicationExcluded(app: string, exclusions: readonly string[] = []): boolean {
  const key = learningApplicationKey(app);
  return exclusions.some((excluded) => learningApplicationKey(excluded) === key);
}

export function normalizeLearningApplications(apps: readonly string[]): readonly string[] {
  if (!Array.isArray(apps) || apps.length > 100) throw new Error("invalid_learning_exclusions");
  const unique = new Map<string, string>();
  for (const app of apps) {
    if (typeof app !== "string" || app.length > 128 || !app.trim() || /[\u0000-\u001f\u007f]/u.test(app))
      throw new Error("invalid_learning_exclusions");
    unique.set(learningApplicationKey(app), app.trim());
  }
  return Object.freeze([...unique.values()]);
}

export function canProcessLearningObservation(observation: LearningObservation, preferences: PassiveLearningPreferences): boolean {
  return !isLearningApplicationExcluded(observation.source.app, preferences.processingExcludedApplications);
}

export function canProcessLearningBatch(batch: LearningBatch, preferences: PassiveLearningPreferences): boolean {
  return batch.observations.every((observation) => canProcessLearningObservation(observation, preferences));
}

export function hasProcessingApplicationsChanged(previous: PassiveLearningPreferences, next: PassiveLearningPreferences): boolean {
  const keys = (value: PassiveLearningPreferences) =>
    (value.processingExcludedApplications ?? []).map(learningApplicationKey).sort();
  return JSON.stringify(keys(previous)) !== JSON.stringify(keys(next));
}
