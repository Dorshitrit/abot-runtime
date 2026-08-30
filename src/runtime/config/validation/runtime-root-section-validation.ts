import { TIMEOUT_CONFIG_FIELDS } from "../fields.js";
import { hasOwnValue } from "../utils.js";
import {
  validateOptionalBoolean,
  validateOptionalObject,
  validateOptionalPositiveNumber,
  validateOptionalSetupString,
  validateOptionalStringArray,
} from "./runtime-config-field-validation.js";
import type { RuntimeConfigValidationOptions } from "./runtime-config-validation-contract.js";

export function validateLoggingConfig(
  issues: string[],
  logging: Record<string, unknown>,
): void {
  validateOptionalBoolean(issues, logging, "enabled", "logging.enabled");
  const rotation = validateOptionalObject(
    issues,
    logging,
    "rotation",
    "logging.rotation",
  );
  if (!rotation) {
    return;
  }
  for (const key of ["maxFileSizeMb", "maxFiles", "maxAgeDays"]) {
    validateOptionalPositiveNumber(
      issues,
      rotation,
      key,
      `logging.rotation.${key}`,
    );
  }
}

export function validatePluginConfig(
  issues: string[],
  plugins: Record<string, unknown>,
): void {
  validateOptionalBoolean(issues, plugins, "enabled", "plugins.enabled");
  validateOptionalStringArray(issues, plugins, "allow", "plugins.allow");
  validateOptionalStringArray(issues, plugins, "deny", "plugins.deny");
  for (const key of Object.keys(plugins)) {
    const isUnsupportedPluginField =
      key !== "enabled" && key !== "allow" && key !== "deny";
    if (isUnsupportedPluginField) {
      issues.push(`plugins.${key} is not a supported configuration field`);
    }
  }
}

function hasInvalidRuntimeTimeout(value: unknown): boolean {
  if (typeof value !== "number") {
    return true;
  }
  if (!Number.isFinite(value)) {
    return true;
  }
  return value <= 0;
}

export function validateRuntimeTimeouts(
  issues: string[],
  timeouts: Record<string, unknown>,
): void {
  for (const field of TIMEOUT_CONFIG_FIELDS) {
    if (!hasOwnValue(timeouts, field.key)) {
      continue;
    }
    if (hasInvalidRuntimeTimeout(timeouts[field.key])) {
      issues.push(`timeouts.${field.key} must be a positive number`);
    }
  }
}

export function validateRootRequestRunnerConfig(
  issues: string[],
  requestRunner: Record<string, unknown>,
  options: RuntimeConfigValidationOptions,
): void {
  const keys = Object.keys(requestRunner);
  const hasUnsupportedRequestRunnerFields = keys.some(
    (key) => key !== "configRef",
  );
  const requiresExactlyOneRequestRunnerField =
    !options.allowIncompleteSetup && keys.length !== 1;
  if (
    hasUnsupportedRequestRunnerFields ||
    requiresExactlyOneRequestRunnerField
  ) {
    issues.push("requestRunner must contain exactly: configRef");
  }

  const configRefIsMissing = !hasOwnValue(requestRunner, "configRef");
  if (configRefIsMissing && !options.allowIncompleteSetup) {
    issues.push("requestRunner.configRef is required");
  }
  if (configRefIsMissing) {
    return;
  }
  validateOptionalSetupString(
    issues,
    requestRunner,
    "configRef",
    "requestRunner.configRef",
    options.allowIncompleteSetup === true,
  );
}

function hasUnsupportedFeatureFlagValue(value: unknown): boolean {
  if (typeof value === "boolean") {
    return false;
  }
  if (typeof value === "number") {
    return false;
  }
  return typeof value !== "string";
}

export function validateFeatureFlagSections(
  issues: string[],
  record: Record<string, unknown>,
): void {
  for (const key of ["features", "featureFlags"]) {
    const flags = validateOptionalObject(issues, record, key);
    if (!flags) {
      continue;
    }
    for (const [flagName, value] of Object.entries(flags)) {
      if (hasUnsupportedFeatureFlagValue(value)) {
        issues.push(`${key}.${flagName} must be a boolean, number, or string`);
      }
    }
  }
}
