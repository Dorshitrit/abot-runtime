import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { RequestRunnerConfig } from "./contracts.js";
import { deepFreezeConfig, formatConfigError } from "./validation.js";
import { parseRequestRunnerConfig } from "./versioned-config.js";

const configCache = new Map<string, RequestRunnerConfig>();

function requestRunnerConfigCachePath(value: string): string {
  const configuredPath = value.trim();
  if (!configuredPath || !isAbsolute(configuredPath)) {
    throw new Error(
      "runtime request runner configPath must be an absolute path resolved from runtime config",
    );
  }
  return resolve(configuredPath);
}

/** Explicit configuration application refreshes only its selected runner. */
export function invalidateRequestRunnerConfig(params: {
  configPath: string;
}): () => void {
  const configPath = requestRunnerConfigCachePath(params.configPath);
  const previous = configCache.get(configPath);
  configCache.delete(configPath);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (previous === undefined) {
      configCache.delete(configPath);
      return;
    }
    configCache.set(configPath, previous);
  };
}

export function loadRequestRunnerConfig(params: {
  configPath: string;
}): RequestRunnerConfig {
  const configPath = requestRunnerConfigCachePath(params.configPath);
  const cached = configCache.get(configPath);
  if (cached) {
    return cached;
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (error: unknown) {
    throw new Error(
      `Unable to read runtime request runner config at ${configPath}: ${formatConfigError(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new Error(
      `Invalid runtime request runner config JSON at ${configPath}: ${formatConfigError(error)}`,
    );
  }

  const config = deepFreezeConfig(parseRequestRunnerConfig(parsed, configPath));
  configCache.set(configPath, config);
  return config;
}
