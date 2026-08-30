import type { RequestRunnerConfig } from "./contracts.js";
import {
  assertRegisteredModelStepKeys,
  materializeRequestRunnerConfig,
  parseRequestRunnerContext,
  parseRequestRunnerModelDefaults,
} from "./config-normalization.js";
import {
  LEGACY_REQUEST_INVOKED_STEP_IDS,
  LEGACY_REQUEST_STEP_TIMEOUT_MS,
  resolveRequestRunnerConfigFileVersion,
} from "./schema-version.js";
import {
  invalidRuntimeConfig,
  requireConfigRecord,
  requireExactConfigKeys,
  requirePositiveConfigInteger,
} from "./validation.js";

function assertLegacyStepCoverage(
  value: Record<string, unknown>,
  configPath: string,
  field: string,
): void {
  for (const stepId of LEGACY_REQUEST_INVOKED_STEP_IDS) {
    if (Object.hasOwn(value, stepId)) {
      continue;
    }
    throw invalidRuntimeConfig(
      configPath,
      field + "." + stepId + " is required by the legacy v1 format",
    );
  }
}

function parseLegacyRequestRunnerConfig(
  root: Record<string, unknown>,
  configPath: string,
): RequestRunnerConfig {
  const context = parseRequestRunnerContext(root, configPath);
  requireExactConfigKeys(
    root,
    ["models", "context", "steps"],
    configPath,
    "root",
  );
  const modelDefaults = parseRequestRunnerModelDefaults(root, configPath);
  const rawSteps = requireConfigRecord(root.steps, configPath, "steps");
  assertRegisteredModelStepKeys(rawSteps, configPath, "steps");
  assertLegacyStepCoverage(
    modelDefaults.rawStepTargets,
    configPath,
    "models.defaults.steps",
  );
  assertLegacyStepCoverage(rawSteps, configPath, "steps");
  return materializeRequestRunnerConfig({
    configPath,
    context,
    defaultTimeoutMs: LEGACY_REQUEST_STEP_TIMEOUT_MS,
    modelDefaults,
    rawSteps,
    requireConfiguredTimeout: true,
  });
}

function parseSparseRequestRunnerConfig(
  root: Record<string, unknown>,
  configPath: string,
): RequestRunnerConfig {
  const context = parseRequestRunnerContext(root, configPath);
  requireExactConfigKeys(
    root,
    ["schemaVersion", "models", "context", "stepDefaults", "steps"],
    configPath,
    "root",
  );
  const stepDefaults = requireConfigRecord(
    root.stepDefaults,
    configPath,
    "stepDefaults",
  );
  requireExactConfigKeys(
    stepDefaults,
    ["timeoutMs"],
    configPath,
    "stepDefaults",
  );
  const rawSteps = requireConfigRecord(root.steps, configPath, "steps");
  assertRegisteredModelStepKeys(rawSteps, configPath, "steps");
  return materializeRequestRunnerConfig({
    configPath,
    context,
    defaultTimeoutMs: requirePositiveConfigInteger(
      stepDefaults.timeoutMs,
      configPath,
      "stepDefaults.timeoutMs",
    ),
    modelDefaults: parseRequestRunnerModelDefaults(root, configPath),
    rawSteps,
    requireConfiguredTimeout: false,
  });
}

export function parseRequestRunnerConfig(
  value: unknown,
  configPath: string,
): RequestRunnerConfig {
  const versioned = resolveRequestRunnerConfigFileVersion(value, configPath);
  if (versioned.version === "legacy-v1") {
    return parseLegacyRequestRunnerConfig(versioned.root, configPath);
  }
  return parseSparseRequestRunnerConfig(versioned.root, configPath);
}
