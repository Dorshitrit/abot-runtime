import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RuntimeConfigFile } from "./types.js";
import { isRecord, readNestedConfigString } from "./utils.js";
import { RuntimeConfigValidationError } from "./validation/runtime-config-validation-contract.js";

const LEGACY_RUNTIME_DIRECTORIES = [
  "scheduler",
  "sessions",
  "attachments",
  "long-term-memory",
  "plugins",
  "memory",
  "logs",
  "local-host",
] as const;

/** Old shared state has no complete environment attribution; never move or hide it. */
export function requireLegacyRuntimeStorageAssignment(params: {
  rootDir: string;
  baseDir: string;
  config: RuntimeConfigFile;
  configPath: string;
  environmentOverride: boolean;
}): void {
  const populated = LEGACY_RUNTIME_DIRECTORIES.filter((directory) =>
    hasStoredEntries(join(params.baseDir, directory)),
  );
  if (populated.length === 0) return;
  if (hasExplicitLegacyOwner(params)) return;
  throw new RuntimeConfigValidationError(params.configPath, [
    `runtime_environment_storage_assignment_required: Existing runtime state at ${params.baseDir} (${populated.join(", ")}) needs an explicit environment owner. Set exactly one environment.profiles.<id>.paths.runtimeDir to this directory, preserving any explicit session, attachment and trace paths. Remove a shared LLM_RUNTIME_DIR override before assigning ownership. No data was moved and no new environment directory was created.`,
  ]);
}

function hasStoredEntries(path: string): boolean {
  try {
    const entry = lstatSync(path);
    if (!entry.isDirectory()) return true;
    return readdirSync(path).length > 0;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function hasExplicitLegacyOwner(params: {
  rootDir: string;
  baseDir: string;
  config: RuntimeConfigFile;
  environmentOverride: boolean;
}): boolean {
  if (params.environmentOverride) return false;
  if (!isRecord(params.config.environment)) return false;
  const profiles = params.config.environment.profiles;
  if (!isRecord(profiles)) return false;
  const owners = Object.values(profiles).filter((profile) => {
    if (!isRecord(profile)) return false;
    const path = readNestedConfigString(profile.paths, "runtimeDir");
    if (!path) return false;
    return sameRuntimeDirectory(resolve(params.rootDir, path), params.baseDir);
  });
  return owners.length === 1;
}

function sameRuntimeDirectory(left: string, right: string): boolean {
  if (process.platform === "win32") {
    return resolve(left).toLowerCase() === resolve(right).toLowerCase();
  }
  return resolve(left) === resolve(right);
}
