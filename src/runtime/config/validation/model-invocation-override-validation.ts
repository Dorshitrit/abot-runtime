import { hasOwnValue, isRecord } from "../utils.js";
import {
  validateModelContextConfig,
  validateModelGenerationConfig,
} from "./model-invocation-config-validation.js";
import {
  validateOptionalObject,
  validateOptionalPositiveInteger,
  validateOptionalString,
  validateOptionalStringArray,
} from "./runtime-config-field-validation.js";

function hasUnsupportedModelInvocationFormat(
  config: Record<string, unknown>,
): boolean {
  if (!hasOwnValue(config, "format") || config.format === "json") {
    return false;
  }
  return !isRecord(config.format);
}

function validateInvocationProfile(
  issues: string[],
  profile: Record<string, unknown>,
  profileKey: string,
): void {
  validateOptionalString(
    issues,
    profile,
    "profileId",
    `${profileKey}.profileId`,
  );
  if (!hasOwnValue(profile, "profileId")) {
    issues.push(`${profileKey}.profileId must be a non-empty string`);
  }

  const generation = validateOptionalObject(
    issues,
    profile,
    "generation",
    `${profileKey}.generation`,
  );
  if (generation) {
    validateModelGenerationConfig(
      issues,
      generation,
      `${profileKey}.generation`,
    );
  }

  const context = validateOptionalObject(
    issues,
    profile,
    "context",
    `${profileKey}.context`,
  );
  if (context) {
    validateModelContextConfig(issues, context, `${profileKey}.context`);
  }

  if (hasUnsupportedModelInvocationFormat(profile)) {
    issues.push(`${profileKey}.format must be json or an object`);
  }
}

export function validateOptionalInvocationProfiles(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey: string,
): void {
  const invocationProfiles = validateOptionalObject(
    issues,
    record,
    key,
    displayKey,
  );
  if (!invocationProfiles) {
    return;
  }
  for (const [profileId, profile] of Object.entries(invocationProfiles)) {
    const profileKey = `${displayKey}.${profileId}`;
    if (!isRecord(profile)) {
      issues.push(`${profileKey} must be an object`);
      continue;
    }
    validateInvocationProfile(issues, profile, profileKey);
  }
}

function validateModelCalibration(
  issues: string[],
  calibration: Record<string, unknown>,
  slotKey: string,
): void {
  validateOptionalString(issues, calibration, "name", `${slotKey}.name`);
  validateOptionalString(
    issues,
    calibration,
    "description",
    `${slotKey}.description`,
  );
  validateOptionalString(
    issues,
    calibration,
    "profileId",
    `${slotKey}.profileId`,
  );
  validateOptionalPositiveInteger(
    issues,
    calibration,
    "timeoutMs",
    `${slotKey}.timeoutMs`,
  );

  const generation = validateOptionalObject(
    issues,
    calibration,
    "generation",
    `${slotKey}.generation`,
  );
  if (generation) {
    validateModelGenerationConfig(issues, generation, `${slotKey}.generation`);
  }

  const context = validateOptionalObject(
    issues,
    calibration,
    "context",
    `${slotKey}.context`,
  );
  if (context) {
    validateModelContextConfig(issues, context, `${slotKey}.context`);
  }

  if (hasUnsupportedModelInvocationFormat(calibration)) {
    issues.push(`${slotKey}.format must be json or an object`);
  }
  validateOptionalStringArray(
    issues,
    calibration,
    "instructions",
    `${slotKey}.instructions`,
  );
}

export function validateOptionalModelCalibrations(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey: string,
): void {
  const calibrations = validateOptionalObject(issues, record, key, displayKey);
  if (!calibrations) {
    return;
  }
  for (const [slotId, calibration] of Object.entries(calibrations)) {
    const slotKey = `${displayKey}.${slotId}`;
    if (!isRecord(calibration)) {
      issues.push(`${slotKey} must be an object`);
      continue;
    }
    validateModelCalibration(issues, calibration, slotKey);
  }
}
