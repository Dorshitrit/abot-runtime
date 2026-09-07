import {
  DEFAULT_MEMORY_RECALL_CALL_LIMIT,
  isMemoryRecallCallLimit,
} from "../long-term-memory/recall-policy.js";
import type { RuntimeLongTermMemoryConfig } from "../ports.js";
import type { RuntimeConfigFile } from "./types.js";
import { isRecord } from "./utils.js";

export const DEFAULT_LONG_TERM_MEMORY_CONFIG: RuntimeLongTermMemoryConfig =
  Object.freeze({
    enabled: false,
    emitClientEvents: false,
    maxRecallCallsPerRequest: DEFAULT_MEMORY_RECALL_CALL_LIMIT,
  });

export function buildLongTermMemoryConfig(
  config: RuntimeConfigFile,
): RuntimeLongTermMemoryConfig {
  if (!isRecord(config.longTermMemory)) {
    return DEFAULT_LONG_TERM_MEMORY_CONFIG;
  }
  const embeddingProfileId = readOptionalString(
    config.longTermMemory.embeddingProfileId,
  );
  return Object.freeze({
    enabled: config.longTermMemory.enabled === true,
    emitClientEvents: config.longTermMemory.emitClientEvents === true,
    maxRecallCallsPerRequest: isMemoryRecallCallLimit(
      config.longTermMemory.maxRecallCallsPerRequest,
    )
      ? config.longTermMemory.maxRecallCallsPerRequest
      : DEFAULT_MEMORY_RECALL_CALL_LIMIT,
    ...(embeddingProfileId ? { embeddingProfileId } : {}),
  });
}

export function validateLongTermMemoryConfig(params: {
  issues: string[];
  value: unknown;
  embeddingProfiles: unknown;
}): void {
  if (params.value === undefined) {
    return;
  }
  if (!isRecord(params.value)) {
    params.issues.push("longTermMemory must be an object");
    return;
  }
  rejectUnsupportedKeys(params.issues, params.value);
  validateOptionalBoolean(params.issues, params.value, "enabled");
  validateOptionalBoolean(params.issues, params.value, "emitClientEvents");
  validateOptionalProfileId(params.issues, params.value);
  validateOptionalMemoryRecallLimit(params.issues, params.value);
  validateEnabledProfileBinding(params);
}

function rejectUnsupportedKeys(
  issues: string[],
  config: Record<string, unknown>,
): void {
  const supported = new Set([
    "enabled",
    "emitClientEvents",
    "embeddingProfileId",
    "maxRecallCallsPerRequest",
  ]);
  for (const key of Object.keys(config)) {
    if (!supported.has(key)) {
      issues.push(
        `longTermMemory.${key} is not a supported configuration field`,
      );
    }
  }
}

function validateOptionalMemoryRecallLimit(
  issues: string[],
  config: Record<string, unknown>,
): void {
  const value = config.maxRecallCallsPerRequest;
  if (value === undefined) return;
  if (isMemoryRecallCallLimit(value)) return;
  issues.push(
    "longTermMemory.maxRecallCallsPerRequest must be a positive safe integer",
  );
}

function validateOptionalBoolean(
  issues: string[],
  config: Record<string, unknown>,
  key: "enabled" | "emitClientEvents",
): void {
  if (config[key] !== undefined && typeof config[key] !== "boolean") {
    issues.push(`longTermMemory.${key} must be a boolean`);
  }
}

function validateOptionalProfileId(
  issues: string[],
  config: Record<string, unknown>,
): void {
  const value = config.embeddingProfileId;
  if (
    value !== undefined &&
    (typeof value !== "string" || value.trim().length === 0)
  ) {
    issues.push("longTermMemory.embeddingProfileId must be a non-empty string");
  }
}

function validateEnabledProfileBinding(params: {
  issues: string[];
  value: Record<string, unknown> | unknown;
  embeddingProfiles: unknown;
}): void {
  if (!isRecord(params.value) || params.value.enabled !== true) {
    return;
  }
  const profileId = readOptionalString(params.value.embeddingProfileId);
  if (!profileId) {
    params.issues.push(
      "longTermMemory.embeddingProfileId is required when longTermMemory.enabled is true",
    );
    return;
  }
  if (
    !isRecord(params.embeddingProfiles) ||
    !Object.hasOwn(params.embeddingProfiles, profileId)
  ) {
    params.issues.push(
      `longTermMemory.embeddingProfileId references unknown embedding profile ${profileId}`,
    );
  }
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
