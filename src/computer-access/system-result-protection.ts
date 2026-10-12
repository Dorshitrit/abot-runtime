import type { SystemApplicationCatalog } from "./application-catalog.js";
import type { SystemApplication, SystemProcessResult } from "./contracts.js";
import type { SystemTargetObservation } from "./target-observation.js";

/** Producer-owned protection, applied before formatting or delivering observations. */
export type SystemResultProtection = Readonly<{
  protectTargets(observation: SystemTargetObservation): SystemTargetObservation;
  protectCatalog(catalog: SystemApplicationCatalog): SystemApplicationCatalog;
  protectProcess(result: SystemProcessResult): SystemProcessResult;
  protectApplication(application: SystemApplication): SystemApplication | undefined;
  protectMessage(message: string): string;
}>;
