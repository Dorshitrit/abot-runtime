import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadRuntimeConfig } from "../config.js";
import { DEFAULT_RUNTIME_CONFIG_FILE } from "../config/constants.js";
import { loadRuntimeConfigFile } from "../config/loader.js";
import { RUNTIME_CONFIG_JSON_SCHEMA } from "../config/schema.js";
import type {
  RuntimeConfigFile,
  RuntimeConfigJsonSchema,
} from "../config/types.js";
import {
  RuntimeConfigValidationError,
  validateRuntimeConfigFile,
} from "../config/validation.js";
import type { RuntimeConfig } from "../ports.js";

export type RuntimeConfigMetadata = {
  rootDir: string;
  configPath: string;
  exists: boolean;
};

export type RuntimeConfigGetResult = {
  metadata: RuntimeConfigMetadata;
  fileConfig: RuntimeConfigFile;
  effectiveConfig: RuntimeConfig;
};

export type RuntimeConfigValidationResult =
  | {
      ok: true;
      config: RuntimeConfigFile;
    }
  | {
      ok: false;
      issues: string[];
      message: string;
    };

export type RuntimeConfigPatchResult = RuntimeConfigValidationResult & {
  metadata: RuntimeConfigMetadata;
  backupPath?: string;
  restartRequired: boolean;
};

type JsonRecord = Record<string, unknown>;

const NON_SECRET_TOKEN_CONFIG_KEYS = new Set([
  "contextwindowtokens",
  "outputreservetokens",
  "safetyreservetokens",
  "attachmentreservetokens",
  "formattokenaccounting",
  "fixedoverheadtokens",
  "tokenestimation",
  "asciicharacterspertoken",
  "nonasciibytespertoken",
  "messageoverheadtokens",
]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveConfigPath(rootDir: string, configPath?: string): string {
  return configPath
    ? join(rootDir, configPath)
    : join(rootDir, DEFAULT_RUNTIME_CONFIG_FILE);
}

function redactConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactConfigValue);
  }
  if (!isRecord(value)) {
    return value;
  }

  const redacted: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    redacted[key] =
      (normalizedKey.includes("token") &&
        !NON_SECRET_TOKEN_CONFIG_KEYS.has(normalizedKey)) ||
      normalizedKey.includes("secret") ||
      normalizedKey.endsWith("apikey")
        ? "[redacted]"
        : redactConfigValue(entry);
  }
  return redacted;
}

function redactRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  return redactConfigValue(config) as RuntimeConfig;
}

function readConfigMetadata(params: {
  rootDir: string;
  configPath?: string;
}): RuntimeConfigMetadata {
  const resolvedPath = resolveConfigPath(params.rootDir, params.configPath);
  return {
    rootDir: params.rootDir,
    configPath: resolvedPath,
    exists: existsSync(resolvedPath),
  };
}

function cloneConfig(config: RuntimeConfigFile): RuntimeConfigFile {
  return JSON.parse(JSON.stringify(config)) as RuntimeConfigFile;
}

function mergePatch(
  base: RuntimeConfigFile,
  patch: RuntimeConfigFile,
): RuntimeConfigFile {
  const output = cloneConfig(base) as JsonRecord;
  for (const [key, value] of Object.entries(patch as JsonRecord)) {
    if (isRecord(value) && isRecord(output[key])) {
      output[key] = mergePatch(
        output[key] as RuntimeConfigFile,
        value as RuntimeConfigFile,
      );
      continue;
    }
    output[key] = value;
  }
  return output;
}

function validationFailure(error: unknown): RuntimeConfigValidationResult {
  if (error instanceof RuntimeConfigValidationError) {
    return {
      ok: false,
      issues: error.issues,
      message: error.message,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    issues: [message],
    message,
  };
}

function validateConfig(
  config: RuntimeConfigFile,
  configPath: string,
): RuntimeConfigValidationResult {
  try {
    validateRuntimeConfigFile(config, configPath);
    return {
      ok: true,
      config,
    };
  } catch (error) {
    return validationFailure(error);
  }
}

async function readExistingConfigText(
  configPath: string,
): Promise<string | null> {
  try {
    return await readFile(configPath, "utf-8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function backupPathFor(configPath: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${configPath}.${stamp}.bak`;
}

export function getRuntimeConfigSchema(): RuntimeConfigJsonSchema {
  return RUNTIME_CONFIG_JSON_SCHEMA;
}

export function getRuntimeConfig(
  params: {
    rootDir?: string;
    configPath?: string;
    env?: Record<string, string | undefined>;
  } = {},
): RuntimeConfigGetResult {
  const rootDir = params.rootDir ?? process.cwd();
  const metadata = readConfigMetadata({
    rootDir,
    configPath: params.configPath,
  });
  const fileConfig = loadRuntimeConfigFile(rootDir, params.configPath);
  const effectiveConfig = redactRuntimeConfig(
    loadRuntimeConfig({
      rootDir,
      configPath: params.configPath,
      env: params.env,
    }),
  );
  return {
    metadata,
    fileConfig: redactConfigValue(fileConfig) as RuntimeConfigFile,
    effectiveConfig,
  };
}

export function validateRuntimeConfigCandidate(params: {
  config?: unknown;
  patch?: unknown;
  rootDir?: string;
  configPath?: string;
}): RuntimeConfigValidationResult {
  const rootDir = params.rootDir ?? process.cwd();
  const resolvedPath = resolveConfigPath(rootDir, params.configPath);

  if (params.config !== undefined) {
    if (!isRecord(params.config)) {
      return {
        ok: false,
        issues: ["config must be an object"],
        message: "config must be an object",
      };
    }
    return validateConfig(params.config as RuntimeConfigFile, resolvedPath);
  }

  if (!isRecord(params.patch)) {
    return {
      ok: false,
      issues: ["patch must be an object"],
      message: "patch must be an object",
    };
  }

  const currentConfig = loadRuntimeConfigFile(rootDir, params.configPath);
  const candidate = mergePatch(
    currentConfig,
    params.patch as RuntimeConfigFile,
  );
  return validateConfig(candidate, resolvedPath);
}

export async function patchRuntimeConfig(params: {
  patch: unknown;
  rootDir?: string;
  configPath?: string;
}): Promise<RuntimeConfigPatchResult> {
  const rootDir = params.rootDir ?? process.cwd();
  const metadata = readConfigMetadata({
    rootDir,
    configPath: params.configPath,
  });
  if (!isRecord(params.patch)) {
    return {
      ok: false,
      issues: ["patch must be an object"],
      message: "patch must be an object",
      metadata,
      restartRequired: false,
    };
  }

  const currentConfig = loadRuntimeConfigFile(rootDir, params.configPath);
  const nextConfig = mergePatch(
    currentConfig,
    params.patch as RuntimeConfigFile,
  );
  const validation = validateConfig(nextConfig, metadata.configPath);
  if (!validation.ok) {
    return {
      ...validation,
      metadata,
      restartRequired: false,
    };
  }

  await mkdir(dirname(metadata.configPath), { recursive: true });
  const existingText = await readExistingConfigText(metadata.configPath);
  const backupPath =
    existingText === null ? undefined : backupPathFor(metadata.configPath);
  if (backupPath && existingText !== null) {
    await writeFile(backupPath, existingText, "utf-8");
  }

  const tempPath = `${metadata.configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(
    tempPath,
    `${JSON.stringify(nextConfig, null, 2)}\n`,
    "utf-8",
  );
  await rename(tempPath, metadata.configPath);

  return {
    ok: true,
    config: redactConfigValue(nextConfig) as RuntimeConfigFile,
    metadata: {
      ...metadata,
      exists: true,
    },
    ...(backupPath ? { backupPath } : {}),
    restartRequired: true,
  };
}
