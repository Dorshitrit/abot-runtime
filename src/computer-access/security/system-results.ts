import type { SystemApplicationCatalog } from "../application-catalog.js";
import type { SystemApplication, SystemProcessResult } from "../contracts.js";
import type { SystemResultProtection } from "../system-result-protection.js";
import type { SystemTargetObservation } from "../target-observation.js";
import { redactSecretText } from "./secret-text.js";

const INCOMPLETE_STREAM = "[UNAVAILABLE: incomplete output cannot be scanned for secrets]";
const SENSITIVE_TARGET = "Target unavailable because its shell identity contains sensitive text.";

function protectApplication(application: SystemApplication): SystemApplication | undefined {
  if (redactSecretText(application.id) !== application.id) return undefined;
  return { ...application, name: redactSecretText(application.name) };
}

function protectCatalog(catalog: SystemApplicationCatalog): SystemApplicationCatalog {
  const applications = catalog.applications.flatMap((application) => {
    const protectedApplication = protectApplication(application);
    return protectedApplication ? [protectedApplication] : [];
  });
  return {
    ...catalog,
    applications,
    complete: catalog.complete && applications.length === catalog.applications.length,
    scope: { ...catalog.scope, roots: catalog.scope.roots.map(redactSecretText) },
  };
}

function protectTargets(observation: SystemTargetObservation): SystemTargetObservation {
  return {
    ...observation,
    host: { ...observation.host, kernelRelease: redactSecretText(observation.host.kernelRelease) },
    targets: observation.targets.map((target) => {
      if (!target.available)
        return { ...target, reason: redactSecretText(target.reason) };
      if (redactSecretText(target.shell) !== target.shell)
        return { id: target.id, available: false, reason: SENSITIVE_TARGET };
      return target;
    }),
  };
}

function protectProcess(result: SystemProcessResult): SystemProcessResult {
  return {
    ...result,
    stdout: result.outputTruncated ? INCOMPLETE_STREAM : redactSecretText(result.stdout),
    stderr: result.outputTruncated ? INCOMPLETE_STREAM : redactSecretText(result.stderr),
    ...(result.spawnedProcess ? {
      spawnedProcess: {
        ...result.spawnedProcess,
        executable: redactSecretText(result.spawnedProcess.executable),
      },
    } : {}),
  };
}

export const systemResultProtection: SystemResultProtection = Object.freeze({
  protectTargets,
  protectCatalog,
  protectProcess,
  protectApplication,
  protectMessage: redactSecretText,
});
