import type { LearningBatch, LearningObservation, PassiveLearningPreferences } from "./contracts.js";
import { isLearningApplicationExcluded, learningApplicationKey } from "./application-policy.js";

export type LearningApplicationSummary = Readonly<{
  app: string;
  observationCount: number;
  lastObservedAt?: string;
  collectionExcluded: boolean;
  processingExcluded: boolean;
}>;

/** Derived metadata only; counts cover retained observations, never lifetime usage. */
export function learningApplicationCatalog(
  queued: readonly LearningObservation[], history: readonly LearningBatch[], preferences: PassiveLearningPreferences,
): { applications: readonly LearningApplicationSummary[]; applicationsOmitted: number } {
  const rows = new Map<string, { app: string; observationCount: number; lastObservedAt?: string }>();
  const rules = [...preferences.excludedApplications, ...preferences.processingExcludedApplications ?? []];
  for (const app of rules) rows.set(learningApplicationKey(app), { app, observationCount: 0 });
  const seen = new Set<string>();
  for (const observation of [...queued, ...history.flatMap((batch) => batch.observations)]) {
    const identity = JSON.stringify([observation.deviceId, observation.id]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const key = learningApplicationKey(observation.source.app);
    const row = rows.get(key) ?? { app: observation.source.app, observationCount: 0 };
    row.observationCount += 1;
    if (!row.lastObservedAt || Date.parse(observation.timestamp) > Date.parse(row.lastObservedAt))
      row.lastObservedAt = observation.timestamp;
    rows.set(key, row);
  }
  const summaries = [...rows.values()].map((row) => ({ ...row,
    collectionExcluded: isLearningApplicationExcluded(row.app, preferences.excludedApplications),
    processingExcluded: isLearningApplicationExcluded(row.app, preferences.processingExcludedApplications),
  }));
  const excluded = summaries.filter((row) => row.collectionExcluded || row.processingExcluded);
  const recent = summaries.filter((row) => !row.collectionExcluded && !row.processingExcluded)
    .sort((a, b) => Date.parse(b.lastObservedAt!) - Date.parse(a.lastObservedAt!));
  return { applications: [...excluded, ...recent.slice(0, 100)], applicationsOmitted: Math.max(0, recent.length - 100) };
}
