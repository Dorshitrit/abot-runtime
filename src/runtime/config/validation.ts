import { STRING_CONFIG_FIELDS } from "./fields.js";
import { validateLongTermMemoryConfig } from "./long-term-memory.js";
import type { RuntimeConfigFile } from "./types.js";
import { hasOwnValue } from "./utils.js";
import { validateEnvironmentConfig } from "./validation/environment-config-validation.js";
import { validateModelConfig } from "./validation/model-registry-validation.js";
import { validatePathConfigRecord } from "./validation/path-config-validation.js";
import {
  validateOptionalObject,
  validateOptionalString,
} from "./validation/runtime-config-field-validation.js";
import {
  RuntimeConfigValidationError,
  type RuntimeConfigValidationOptions,
} from "./validation/runtime-config-validation-contract.js";
import {
  validateFeatureFlagSections,
  validateLoggingConfig,
  validatePluginConfig,
  validateRootRequestRunnerConfig,
  validateRuntimeTimeouts,
} from "./validation/runtime-root-section-validation.js";
import { validateWebUiConfigSection } from "./validation/web-ui-config-validation.js";

export { validateModelProfileConfig } from "./validation/model-profile-validation.js";
export { validateRuntimeWebUiConfig } from "./validation/web-ui-config-validation.js";
export { RuntimeConfigValidationError };

export function validateRuntimeConfigFile(
  config: RuntimeConfigFile,
  configPath: string,
  options: RuntimeConfigValidationOptions = {},
): void {
  const issues: string[] = [];
  const record = config as Record<string, unknown>;
  const supportedRootFields = new Set([
    "agentBridgeUrl",
    "agentBridgeToken",
    "modelGatewayUrl",
    "environment",
    "webUi",
    "paths",
    "logging",
    "timeouts",
    "plugins",
    "longTermMemory",
    "models",
    "requestRunner",
    "features",
    "featureFlags",
  ]);
  for (const key of Object.keys(record)) {
    if (!supportedRootFields.has(key)) {
      issues.push(`${key} is not a supported runtime configuration field`);
    }
  }

  for (const field of STRING_CONFIG_FIELDS) {
    validateOptionalString(issues, record, field.path);
  }

  const environment = validateOptionalObject(
    issues,
    record,
    "environment",
    "environment",
  );
  if (environment) {
    validateEnvironmentConfig(issues, environment);
  }

  validateWebUiConfigSection(issues, record);

  const paths = validateOptionalObject(issues, record, "paths");
  if (paths) {
    validatePathConfigRecord(issues, paths, "paths");
  }

  const timeouts = validateOptionalObject(issues, record, "timeouts");
  if (timeouts) {
    validateRuntimeTimeouts(issues, timeouts);
  }

  const logging = validateOptionalObject(issues, record, "logging");
  if (logging) {
    validateLoggingConfig(issues, logging);
  }

  const plugins = validateOptionalObject(issues, record, "plugins");
  if (plugins) {
    validatePluginConfig(issues, plugins);
  }

  const models = validateOptionalObject(issues, record, "models");
  if (models) {
    validateModelConfig(issues, models, options);
  }
  const requiredModelsAreMissing =
    !models && !hasOwnValue(record, "models") && !options.allowIncompleteSetup;
  if (requiredModelsAreMissing) {
    issues.push("models is required");
  }

  validateLongTermMemoryConfig({
    issues,
    value: record.longTermMemory,
    embeddingProfiles: models?.embeddingProfiles,
  });

  const requestRunner = validateOptionalObject(issues, record, "requestRunner");
  if (requestRunner) {
    validateRootRequestRunnerConfig(issues, requestRunner, options);
  }
  const requiredRequestRunnerIsMissing =
    !requestRunner &&
    !hasOwnValue(record, "requestRunner") &&
    !options.allowIncompleteSetup;
  if (requiredRequestRunnerIsMissing) {
    issues.push("requestRunner.configRef is required");
  }

  validateFeatureFlagSections(issues, record);

  if (issues.length > 0) {
    throw new RuntimeConfigValidationError(configPath, issues);
  }
}
