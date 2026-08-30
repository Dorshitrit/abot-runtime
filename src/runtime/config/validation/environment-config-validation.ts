import { hasOwnValue, isRecord } from "../utils.js";
import {
  validateOptionalObject,
  validateOptionalString,
} from "./runtime-config-field-validation.js";
import { validatePathConfigRecord } from "./path-config-validation.js";

function validateEnvironmentProfilePaths(
  issues: string[],
  profileId: string,
  profile: unknown,
): void {
  if (!isRecord(profile)) {
    issues.push(`environment.profiles.${profileId} must be an object`);
    return;
  }
  const paths = validateOptionalObject(
    issues,
    profile,
    "paths",
    `environment.profiles.${profileId}.paths`,
  );
  if (!paths) {
    return;
  }
  validatePathConfigRecord(
    issues,
    paths,
    `environment.profiles.${profileId}.paths`,
  );
}

function hasUnknownDefaultEnvironmentProfile(
  environment: Record<string, unknown>,
  profiles: Record<string, unknown>,
): boolean {
  if (typeof environment.default !== "string") {
    return false;
  }
  const defaultProfileId = environment.default.trim();
  if (defaultProfileId.length === 0) {
    return false;
  }
  return !hasOwnValue(profiles, defaultProfileId);
}

export function validateEnvironmentConfig(
  issues: string[],
  environment: Record<string, unknown>,
): void {
  validateOptionalString(issues, environment, "default", "environment.default");
  const basePaths = validateOptionalObject(
    issues,
    environment,
    "paths",
    "environment.paths",
  );
  if (basePaths) {
    validatePathConfigRecord(issues, basePaths, "environment.paths");
  }

  const profiles = validateOptionalObject(
    issues,
    environment,
    "profiles",
    "environment.profiles",
  );
  if (!profiles) {
    return;
  }

  for (const [profileId, profile] of Object.entries(profiles)) {
    validateEnvironmentProfilePaths(issues, profileId, profile);
  }

  if (hasUnknownDefaultEnvironmentProfile(environment, profiles)) {
    issues.push(
      "environment.default must match a key under environment.profiles",
    );
  }
}
