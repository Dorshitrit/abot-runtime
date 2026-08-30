import { validateEmbeddingProfiles } from "../embedding-profiles.js";
import { hasOwnValue, isRecord } from "../utils.js";
import { validateModelContextConfig } from "./model-invocation-config-validation.js";
import { validateOptionalInvocationProfiles } from "./model-invocation-override-validation.js";
import { validateModelProfileConfig } from "./model-profile-validation.js";
import {
  validateOptionalBoolean,
  validateOptionalEnvVarName,
  validateOptionalObject,
  validateOptionalString,
  validateOptionalStringMap,
} from "./runtime-config-field-validation.js";
import type { RuntimeConfigValidationOptions } from "./runtime-config-validation-contract.js";

const PROVIDER_ADAPTER_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/u;

function isAllowedIncompleteProviderType(
  provider: Record<string, unknown>,
  options: RuntimeConfigValidationOptions,
): boolean {
  if (options.allowIncompleteSetup !== true) {
    return false;
  }
  if (!hasOwnValue(provider, "type")) {
    return true;
  }
  if (typeof provider.type !== "string") {
    return false;
  }
  return provider.type.trim().length === 0;
}

function hasInvalidProviderAdapterIdentifier(
  provider: Record<string, unknown>,
  options: RuntimeConfigValidationOptions,
): boolean {
  if (isAllowedIncompleteProviderType(provider, options)) {
    return false;
  }
  if (!hasOwnValue(provider, "type")) {
    return true;
  }
  if (typeof provider.type !== "string") {
    return true;
  }
  return !PROVIDER_ADAPTER_IDENTIFIER_PATTERN.test(provider.type.trim());
}

function validateProviderEntry(
  issues: string[],
  providerId: string,
  provider: unknown,
  options: RuntimeConfigValidationOptions,
): void {
  const providerKey = `models.providers.${providerId}`;
  if (providerId.trim().length === 0) {
    issues.push("models.providers keys must be non-empty strings");
  }
  if (!isRecord(provider)) {
    issues.push(`${providerKey} must be an object`);
    return;
  }
  if (hasInvalidProviderAdapterIdentifier(provider, options)) {
    issues.push(`${providerKey}.type must be a provider adapter identifier`);
  }
  validateOptionalString(issues, provider, "baseUrl", `${providerKey}.baseUrl`);
  validateOptionalEnvVarName(
    issues,
    provider,
    "apiKeyEnv",
    `${providerKey}.apiKeyEnv`,
  );
  validateOptionalString(
    issues,
    provider,
    "keepAlive",
    `${providerKey}.keepAlive`,
  );
  validateOptionalObject(
    issues,
    provider,
    "settings",
    `${providerKey}.settings`,
  );
}

function validateModelProviders(
  issues: string[],
  models: Record<string, unknown>,
  options: RuntimeConfigValidationOptions,
): void {
  const providers = validateOptionalObject(issues, models, "providers");
  const requiredProvidersAreMissing =
    !hasOwnValue(models, "providers") && !options.allowIncompleteSetup;
  if (requiredProvidersAreMissing) {
    issues.push("models.providers must declare at least one provider");
  }
  if (!providers) {
    return;
  }
  if (Object.keys(providers).length === 0 && !options.allowIncompleteSetup) {
    issues.push("models.providers must declare at least one provider");
  }
  for (const [providerId, provider] of Object.entries(providers)) {
    validateProviderEntry(issues, providerId, provider, options);
  }
}

function validateModelProfileEntry(
  issues: string[],
  profileId: string,
  profile: unknown,
  options: RuntimeConfigValidationOptions,
): void {
  if (profileId.trim().length === 0) {
    issues.push("models.profiles keys must be non-empty strings");
  }
  if (!isRecord(profile)) {
    issues.push(`models.profiles.${profileId} must be an object`);
    return;
  }
  validateModelProfileConfig(issues, profile, `models.profiles.${profileId}`, {
    allowConfigRef: true,
    allowIncompleteSetup: options.allowIncompleteSetup,
  });
}

function validateModelProfiles(
  issues: string[],
  models: Record<string, unknown>,
  options: RuntimeConfigValidationOptions,
): void {
  const profiles = validateOptionalObject(issues, models, "profiles");
  const requiredProfilesAreMissing =
    !hasOwnValue(models, "profiles") && !options.allowIncompleteSetup;
  if (requiredProfilesAreMissing) {
    issues.push("models.profiles must declare at least one model profile");
  }
  if (!profiles) {
    return;
  }
  if (Object.keys(profiles).length === 0 && !options.allowIncompleteSetup) {
    issues.push("models.profiles must declare at least one model profile");
  }
  for (const [profileId, profile] of Object.entries(profiles)) {
    validateModelProfileEntry(issues, profileId, profile, options);
  }
}

function validateModelDefaults(
  issues: string[],
  models: Record<string, unknown>,
): void {
  const defaults = validateOptionalObject(issues, models, "defaults");
  if (!defaults) {
    return;
  }
  validateOptionalBoolean(
    issues,
    defaults,
    "overrideClientPreference",
    "models.defaults.overrideClientPreference",
  );
  validateOptionalString(
    issues,
    defaults,
    "profileId",
    "models.defaults.profileId",
  );
  validateOptionalStringMap(issues, defaults, "roles", "models.defaults.roles");
  validateOptionalStringMap(issues, defaults, "steps", "models.defaults.steps");
  const defaultContext = validateOptionalObject(
    issues,
    defaults,
    "context",
    "models.defaults.context",
  );
  if (defaultContext) {
    validateModelContextConfig(
      issues,
      defaultContext,
      "models.defaults.context",
    );
  }
}

export function validateModelConfig(
  issues: string[],
  models: Record<string, unknown>,
  options: RuntimeConfigValidationOptions = {},
): void {
  validateModelProviders(issues, models, options);
  validateModelProfiles(issues, models, options);
  validateOptionalInvocationProfiles(
    issues,
    models,
    "invocationProfiles",
    "models.invocationProfiles",
  );
  validateEmbeddingProfiles({
    issues,
    models,
    allowIncompleteSetup: options.allowIncompleteSetup === true,
  });
  validateModelDefaults(issues, models);
}
