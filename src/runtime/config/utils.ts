import { isAbsolute, resolve } from "node:path";

import type { RuntimeConfigFile, RuntimeEnv } from "./types.js";

export function readFirstString(
  env: RuntimeEnv,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function readPositiveInt(
  env: RuntimeEnv,
  name: string,
): number | undefined {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readConfigString(
  config: RuntimeConfigFile,
  key: keyof RuntimeConfigFile,
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function readNestedConfigString(
  value: unknown,
  key: string,
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const nested = value[key];
  return typeof nested === "string" && nested.trim().length > 0
    ? nested.trim()
    : undefined;
}

export function readConfigPositiveInt(
  value: unknown,
  key: string,
): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const raw = value[key];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : undefined;
}

export function readNestedConfigStringArray(
  value: unknown,
  key: string,
): string[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const nested = value[key];
  if (!Array.isArray(nested)) {
    return undefined;
  }
  const entries = nested.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
  return entries.length > 0
    ? [...new Set(entries.map((entry) => entry.trim()))]
    : undefined;
}

export function readOptionalBoolean(
  value: unknown,
  key: string,
): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const raw = value[key];
  return typeof raw === "boolean" ? raw : undefined;
}

export function readOptionalStringMap(
  value: unknown,
  key: string,
): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const raw = value[key];
  if (!isRecord(raw)) {
    return undefined;
  }
  const entries = Object.entries(raw)
    .map(([entryKey, entryValue]) => [
      entryKey,
      typeof entryValue === "string" ? entryValue.trim() : "",
    ])
    .filter((entry): entry is [string, string] => entry[1].length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function resolveRuntimePath(rootDir: string, value: string): string {
  return isAbsolute(value) ? value : resolve(rootDir, value);
}

export function hasOwnValue(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
