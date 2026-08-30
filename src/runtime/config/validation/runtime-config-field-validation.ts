import { hasOwnValue, isRecord } from "../utils.js";

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isNonEmptyConfigString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAllowedIncompleteSetupString(
  record: Record<string, unknown>,
  key: string,
  allowIncompleteSetup: boolean,
): boolean {
  if (!allowIncompleteSetup) {
    return false;
  }
  if (!hasOwnValue(record, key)) {
    return false;
  }
  const value = record[key];
  return typeof value === "string" && value.trim().length === 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveNumber(value: unknown): value is number {
  if (!isFiniteNumber(value)) {
    return false;
  }
  return value > 0;
}

function isPositiveInteger(value: unknown): value is number {
  if (!isPositiveNumber(value)) {
    return false;
  }
  return Number.isInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  if (!isFiniteNumber(value) || value < 0) {
    return false;
  }
  return Number.isInteger(value);
}

export function validateOptionalString(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  if (!isNonEmptyConfigString(record[key])) {
    issues.push(`${displayKey} must be a non-empty string`);
  }
}

export function validateOptionalSetupString(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey: string,
  allowIncompleteSetup: boolean,
): void {
  if (isAllowedIncompleteSetupString(record, key, allowIncompleteSetup)) {
    return;
  }
  validateOptionalString(issues, record, key, displayKey);
}

export function validateOptionalEnvVarName(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  const value = record[key];
  if (!isNonEmptyConfigString(value)) {
    issues.push(`${displayKey} must be a non-empty string`);
    return;
  }
  if (!ENV_VAR_NAME_PATTERN.test(value.trim())) {
    issues.push(`${displayKey} must be an environment variable name`);
  }
}

export function validateOptionalObject(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): Record<string, unknown> | undefined {
  if (!hasOwnValue(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (!isRecord(value)) {
    issues.push(`${displayKey} must be an object`);
    return undefined;
  }
  return value;
}

export function validateOptionalBoolean(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  if (typeof record[key] !== "boolean") {
    issues.push(`${displayKey} must be a boolean`);
  }
}

export function validateOptionalStringArray(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  const value = record[key];
  if (!Array.isArray(value)) {
    issues.push(`${displayKey} must be an array of strings`);
    return;
  }
  if (value.some((entry) => typeof entry !== "string")) {
    issues.push(`${displayKey} must contain only strings`);
  }
}

export function validateOptionalModelModalityArray(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  const value = record[key];
  if (!Array.isArray(value)) {
    issues.push(`${displayKey} must be an array of model modalities`);
    return;
  }
  for (const entry of value) {
    if (entry !== "text" && entry !== "image" && entry !== "audio") {
      issues.push(`${displayKey} must contain only text, image, or audio`);
      return;
    }
  }
}

export function validateOptionalStringMap(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  const value = record[key];
  if (!isRecord(value)) {
    issues.push(`${displayKey} must be an object`);
    return;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== "string" || entryValue.trim().length === 0) {
      issues.push(`${displayKey}.${entryKey} must be a non-empty string`);
    }
  }
}

export function validateOptionalNumber(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  if (!isFiniteNumber(record[key])) {
    issues.push(`${displayKey} must be a number`);
  }
}

export function validateOptionalPositiveNumber(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  if (!isPositiveNumber(record[key])) {
    issues.push(`${displayKey} must be a positive number`);
  }
}

export function validateOptionalPositiveInteger(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  if (!isPositiveInteger(record[key])) {
    issues.push(`${displayKey} must be a positive integer`);
  }
}

export function validateOptionalNonNegativeInteger(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  if (!isNonNegativeInteger(record[key])) {
    issues.push(`${displayKey} must be a non-negative integer`);
  }
}
