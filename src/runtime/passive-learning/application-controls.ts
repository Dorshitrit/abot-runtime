import type { LearningActiveBatches } from "./active-batches.js";
import type { PassiveLearningPreferences } from "./contracts.js";
import { hasProcessingApplicationsChanged } from "./application-policy.js";

/** Exclusion changes settle affected work before publishing the saved policy. */
export async function commitLearningApplicationPreferences(options: {
  previous: PassiveLearningPreferences;
  next: PassiveLearningPreferences;
  active: LearningActiveBatches;
  suspend(): () => void;
  commit(): Promise<void>;
}): Promise<void> {
  if (!hasProcessingApplicationsChanged(options.previous, options.next)) return options.commit();
  const resume = options.suspend();
  try {
    await options.active.excludeApplications(options.next.processingExcludedApplications ?? []);
    await options.commit();
  } finally {
    resume();
  }
}
