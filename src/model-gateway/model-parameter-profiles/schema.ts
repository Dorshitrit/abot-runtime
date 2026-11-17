import type {
  ModelParameterConstraint,
  ModelParameterKey,
  ModelParameterProfile,
  ModelParameterValue,
} from "../../shared/model-parameters.js";
import {
  getModelParameterDefinition,
  validateModelParameterValue,
} from "../../shared/model-parameter-validation.js";

function isProfileRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireProfileRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (!isProfileRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function requireKnownFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!fields.includes(key))
      throw new Error(`${path}.${key} is not supported`);
  }
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${path} must be a non-empty string`);
  return value;
}

function requireParameterKey(key: string, path: string): ModelParameterKey {
  if (!getModelParameterDefinition(key))
    throw new Error(`${path}.${key} is not a registered parameter`);
  return key as ModelParameterKey;
}

function requireParameterValue(
  key: ModelParameterKey,
  value: unknown,
  path: string,
): ModelParameterValue {
  const issue = validateModelParameterValue(key, value);
  if (issue) throw new Error(`${path}: ${issue}`);
  return value as ModelParameterValue;
}

function requireParameterValues(
  key: ModelParameterKey,
  value: unknown,
  path: string,
): ModelParameterValue[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${path} must be a non-empty array`);
  return value.map((entry) => requireParameterValue(key, entry, path));
}

function parseProfileMatch(value: unknown): ModelParameterProfile["match"] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("match must be a non-empty array");
  return value.map((entry, index) => {
    const path = `match[${index}]`;
    const record = requireProfileRecord(entry, path);
    requireKnownFields(record, ["provider", "kind", "pattern"], path);
    const kind = record.kind;
    if (kind !== "exact" && kind !== "glob" && kind !== "regex")
      throw new Error(`${path}.kind must be exact, glob, or regex`);
    const pattern = requireNonEmptyString(record.pattern, `${path}.pattern`);
    if (pattern.length > 512)
      throw new Error(`${path}.pattern exceeds 512 characters`);
    if (kind === "regex") new RegExp(pattern);
    const provider =
      record.provider === undefined
        ? undefined
        : requireNonEmptyString(record.provider, `${path}.provider`);
    return { kind, pattern, ...(provider ? { provider } : {}) };
  });
}

function parseProfileDefaults(
  value: unknown,
): ModelParameterProfile["defaults"] {
  if (value === undefined) return undefined;
  const record = requireProfileRecord(value, "defaults");
  return Object.fromEntries(
    Object.entries(record).map(([rawKey, entry]) => {
      const key = requireParameterKey(rawKey, "defaults");
      return [key, requireParameterValue(key, entry, `defaults.${key}`)];
    }),
  );
}

function parseProfileReasoning(
  value: unknown,
): ModelParameterProfile["reasoning"] {
  if (value === undefined) return undefined;
  const record = requireProfileRecord(value, "reasoning");
  requireKnownFields(
    record,
    ["efforts", "mappings", "canDisableThinking"],
    "reasoning",
  );
  if (!Array.isArray(record.efforts) || record.efforts.length === 0)
    throw new Error("reasoning.efforts must be a non-empty array");
  const efforts = record.efforts.map((effort) => {
    requireParameterValue("reasoning_effort", effort, "reasoning.efforts");
    return requireNonEmptyString(effort, "reasoning.efforts");
  });
  if (new Set(efforts).size !== efforts.length)
    throw new Error("reasoning.efforts must be unique");
  if (
    record.canDisableThinking !== undefined &&
    typeof record.canDisableThinking !== "boolean"
  )
    throw new Error("reasoning.canDisableThinking must be boolean");
  if (efforts.includes("none") && record.canDisableThinking !== true)
    throw new Error(
      "reasoning.efforts may include none only when canDisableThinking is true",
    );
  const mappings = parseReasoningMappings(record.mappings, efforts);
  return {
    efforts,
    ...(mappings ? { mappings } : {}),
    ...(record.canDisableThinking !== undefined
      ? { canDisableThinking: record.canDisableThinking as boolean }
      : {}),
  };
}

function parseReasoningMappings(
  value: unknown,
  efforts: readonly string[],
): Record<string, string | null> | undefined {
  if (value === undefined) return undefined;
  const mappings = requireProfileRecord(value, "reasoning.mappings");
  for (const [source, target] of Object.entries(mappings)) {
    requireNonEmptyString(source, "reasoning.mappings key");
    if (target === null) continue;
    if (typeof target !== "string" || !efforts.includes(target))
      throw new Error(
        `reasoning.mappings.${source} must target a declared effort or null`,
      );
  }
  return { ...mappings } as Record<string, string | null>;
}

function parseConstraint(
  key: ModelParameterKey,
  value: unknown,
): ModelParameterConstraint {
  const path = `constraints.${key}`;
  const record = requireProfileRecord(value, path);
  requireKnownFields(
    record,
    ["supported", "min", "max", "values", "requires"],
    path,
  );
  if (record.supported !== undefined && typeof record.supported !== "boolean")
    throw new Error(`${path}.supported must be boolean`);
  for (const bound of ["min", "max"] as const) {
    if (record[bound] === undefined) continue;
    if (typeof record[bound] !== "number" || !Number.isFinite(record[bound]))
      throw new Error(`${path}.${bound} must be finite`);
  }
  if (
    typeof record.min === "number" &&
    typeof record.max === "number" &&
    record.min > record.max
  )
    throw new Error(`${path}.min exceeds max`);
  const values =
    record.values === undefined
      ? undefined
      : requireParameterValues(key, record.values, `${path}.values`);
  const requires = parseConstraintRequirement(record.requires, path);
  return {
    ...record,
    ...(values ? { values } : {}),
    ...(requires ? { requires } : {}),
  } as ModelParameterConstraint;
}

function parseConstraintRequirement(
  value: unknown,
  path: string,
): ModelParameterConstraint["requires"] {
  if (value === undefined) return undefined;
  const record = requireProfileRecord(value, `${path}.requires`);
  requireKnownFields(
    record,
    ["key", "values", "allowMissing"],
    `${path}.requires`,
  );
  if (
    record.allowMissing !== undefined &&
    typeof record.allowMissing !== "boolean"
  )
    throw new Error(`${path}.requires.allowMissing must be boolean`);
  const key = requireParameterKey(
    requireNonEmptyString(record.key, `${path}.requires.key`),
    path,
  );
  return {
    key,
    values: requireParameterValues(
      key,
      record.values,
      `${path}.requires.values`,
    ),
    ...(record.allowMissing !== undefined
      ? { allowMissing: record.allowMissing as boolean }
      : {}),
  };
}

function parseProfileConstraints(
  value: unknown,
): ModelParameterProfile["constraints"] {
  if (value === undefined) return undefined;
  const record = requireProfileRecord(value, "constraints");
  return Object.fromEntries(
    Object.entries(record).map(([rawKey, constraint]) => {
      const key = requireParameterKey(rawKey, "constraints");
      return [key, parseConstraint(key, constraint)];
    }),
  );
}

function validateDefaultConstraints(profile: ModelParameterProfile): void {
  for (const [key, value] of Object.entries(profile.defaults ?? {})) {
    const constraint = profile.constraints?.[key as ModelParameterKey];
    if (constraint?.supported === false)
      throw new Error(`defaults.${key} is forbidden by constraints`);
    if (constraint?.values && !constraint.values.includes(value))
      throw new Error(`defaults.${key} is outside constraint values`);
    if (typeof value !== "number") continue;
    if (constraint?.min !== undefined && value < constraint.min)
      throw new Error(`defaults.${key} is below constraint minimum`);
    if (constraint?.max !== undefined && value > constraint.max)
      throw new Error(`defaults.${key} exceeds constraint maximum`);
  }
  const effort = profile.defaults?.reasoning_effort;
  if (
    effort !== undefined &&
    profile.reasoning &&
    !profile.reasoning.efforts.includes(String(effort))
  )
    throw new Error("defaults.reasoning_effort must be a declared effort");
}

export function parseModelParameterProfile(
  value: unknown,
  expectedId?: string,
): ModelParameterProfile {
  const record = requireProfileRecord(value, "profile");
  requireKnownFields(
    record,
    [
      "schemaVersion",
      "id",
      "priority",
      "match",
      "defaults",
      "reasoning",
      "constraints",
      "notes",
    ],
    "profile",
  );
  if (record.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  const id = requireNonEmptyString(record.id, "id");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id))
    throw new Error("id must be a filename-safe identifier");
  if (expectedId !== undefined && expectedId !== id)
    throw new Error(`id must match filename ${expectedId}.json`);
  if (record.priority !== undefined && !Number.isSafeInteger(record.priority))
    throw new Error("priority must be a safe integer");
  if (record.notes !== undefined && typeof record.notes !== "string")
    throw new Error("notes must be a string");
  const profile: ModelParameterProfile = {
    schemaVersion: 1,
    id,
    match: parseProfileMatch(record.match),
    ...(record.priority !== undefined
      ? { priority: record.priority as number }
      : {}),
    ...(record.defaults !== undefined
      ? { defaults: parseProfileDefaults(record.defaults) }
      : {}),
    ...(record.reasoning !== undefined
      ? { reasoning: parseProfileReasoning(record.reasoning) }
      : {}),
    ...(record.constraints !== undefined
      ? { constraints: parseProfileConstraints(record.constraints) }
      : {}),
    ...(record.notes !== undefined ? { notes: record.notes as string } : {}),
  };
  validateDefaultConstraints(profile);
  return profile;
}
