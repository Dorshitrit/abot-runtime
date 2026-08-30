import { hasOwnValue, isRecord } from "./utils.js";

export function validateEmbeddingProfiles(params: {
  issues: string[];
  models: Record<string, unknown>;
  allowIncompleteSetup: boolean;
}): void {
  if (!hasOwnValue(params.models, "embeddingProfiles")) {
    return;
  }
  const profiles = params.models.embeddingProfiles;
  if (!isRecord(profiles)) {
    params.issues.push("models.embeddingProfiles must be an object");
    return;
  }
  for (const [profileId, profile] of Object.entries(profiles)) {
    validateEmbeddingProfile({ ...params, profileId, profile });
  }
}

function validateEmbeddingProfile(params: {
  issues: string[];
  models: Record<string, unknown>;
  allowIncompleteSetup: boolean;
  profileId: string;
  profile: unknown;
}): void {
  const displayKey = `models.embeddingProfiles.${params.profileId}`;
  if (!params.profileId.trim()) {
    params.issues.push("models.embeddingProfiles keys must be non-empty strings");
  }
  if (!isRecord(params.profile)) {
    params.issues.push(`${displayKey} must be an object`);
    return;
  }
  const profile = params.profile;
  rejectUnsupportedFields(params.issues, profile, displayKey);
  validateOptionalString(params.issues, profile, "label", displayKey);
  validateRequiredString({ ...params, profile }, "provider", displayKey);
  validateRequiredString({ ...params, profile }, "model", displayKey);
  if (hasOwnValue(profile, "options") && !isRecord(profile.options)) {
    params.issues.push(`${displayKey}.options must be an object`);
  }
  validateProviderReference({ ...params, profile }, displayKey);
}

function rejectUnsupportedFields(
  issues: string[],
  profile: Record<string, unknown>,
  displayKey: string,
): void {
  const supported = new Set(["label", "provider", "model", "options"]);
  for (const key of Object.keys(profile)) {
    if (!supported.has(key)) {
      issues.push(`${displayKey}.${key} is not supported for embeddings`);
    }
  }
}

function validateRequiredString(
  params: {
    issues: string[];
    profile: Record<string, unknown>;
    allowIncompleteSetup: boolean;
  },
  key: "provider" | "model",
  displayKey: string,
): void {
  if (params.allowIncompleteSetup && !hasOwnValue(params.profile, key)) {
    return;
  }
  const value = params.profile[key];
  if (typeof value !== "string" || !value.trim()) {
    params.issues.push(`${displayKey}.${key} must be a non-empty string`);
  }
}

function validateOptionalString(
  issues: string[],
  profile: Record<string, unknown>,
  key: "label",
  displayKey: string,
): void {
  const value = profile[key];
  if (value !== undefined && (typeof value !== "string" || !value.trim())) {
    issues.push(`${displayKey}.${key} must be a non-empty string`);
  }
}

function validateProviderReference(
  params: {
    issues: string[];
    models: Record<string, unknown>;
    profile: Record<string, unknown>;
  },
  displayKey: string,
): void {
  const providerId = params.profile.provider;
  if (typeof providerId !== "string" || !providerId.trim()) {
    return;
  }
  const providers = params.models.providers;
  if (!isRecord(providers) || !Object.hasOwn(providers, providerId.trim())) {
    params.issues.push(
      `${displayKey}.provider references unknown provider ${providerId.trim()}`,
    );
  }
}
