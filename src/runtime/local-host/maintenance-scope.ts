import { realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { loadRuntimeConfig } from "../config.js";
import { inspectRuntimeConfigFileWithMeta } from "../config/loader.js";
import type { RuntimeConfig } from "../ports.js";
import { isOwnedRotatedLogName } from "../observability/log-rotation.js";
import { basename, dirname, join } from "node:path";

function normalizedPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function isWithinStoragePath(parent: string, child: string): boolean {
  const suffix = relative(normalizedPath(parent), normalizedPath(child));
  if (!suffix) return true;
  if (isAbsolute(suffix)) return false;
  if (suffix === "..") return false;
  return !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

function hasOverlappingStoragePaths(left: string, right: string): boolean {
  if (isWithinStoragePath(left, right)) return true;
  return isWithinStoragePath(right, left);
}

function hasOverlappingTraceFamilies(left: string, right: string): boolean {
  if (samePath(left, right)) return true;
  if (!samePath(dirname(left), dirname(right))) return false;
  if (isOwnedRotatedLogName(left, basename(right))) return true;
  return isOwnedRotatedLogName(right, basename(left));
}

function sessionOwnedPaths(config: RuntimeConfig): string[] {
  return [config.paths.sessionsDir, config.paths.attachmentsDir,
    join(config.paths.runtimeDir, "scheduler"), join(config.paths.runtimeDir, "spark-chat"),
    join(config.paths.runtimeDir, "web-ui", "read-state")];
}

function configuredEnvironmentIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || !("profiles" in value)) return [];
  const profiles = value.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return [];
  return Object.keys(profiles);
}

/** Refuse ambiguous storage ownership; never infer a config source from state files. */
export async function assertRuntimeMaintenanceScope(config: RuntimeConfig, operation: "sessions" | "logs"): Promise<void> {
  let configurations: RuntimeConfig[];
  try {
    const source = inspectRuntimeConfigFileWithMeta(config.paths.rootDir, process.env.LLM_RUNTIME_CONFIG_FILE);
    if (!source.exists) throw new Error("missing_configuration");
    const ids = configuredEnvironmentIds(source.config.environment);
    configurations = (ids.length ? ids : [undefined]).map(profileId => loadRuntimeConfig({
      rootDir: config.paths.rootDir, configPath: source.path, profileId, env: process.env,
    }));
  } catch {
    throw new Error("runtime_maintenance_scope_unavailable");
  }
  const selected = configurations.find(item => item.runtimeId === config.runtimeId);
  if (!selected) throw new Error("runtime_maintenance_scope_unavailable");
  const keys = operation === "sessions" ? ["sessionsDir", "attachmentsDir", "runtimeDir"] as const : ["traceFile"] as const;
  for (const key of keys) {
    if (!samePath(selected.paths[key], config.paths[key])) throw new Error("runtime_maintenance_scope_unavailable");
  }
  const ownedPaths = operation === "sessions" ? sessionOwnedPaths(config) : [config.paths.traceFile];
  for (const path of ownedPaths) {
    const physical = await physicalStoragePath(path);
    if (!samePath(physical, path)) throw new Error("runtime_maintenance_shared_paths");
  }
  for (const other of configurations) {
    if (other.runtimeId === config.runtimeId) continue;
    if (operation === "logs") {
      if (hasOverlappingTraceFamilies(config.paths.traceFile, await physicalStoragePath(other.paths.traceFile)))
        throw new Error("runtime_maintenance_shared_paths");
      continue;
    }
    const otherPaths = await Promise.all(sessionOwnedPaths(other).map(physicalStoragePath));
    for (const owned of ownedPaths) {
      if (otherPaths.some(path => hasOverlappingStoragePaths(owned, path)))
        throw new Error("runtime_maintenance_shared_paths");
    }
  }
}

async function physicalStoragePath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
      throw new Error("runtime_maintenance_scope_unavailable");
    const parent = dirname(resolve(path));
    if (parent === resolve(path)) return resolve(path);
    return resolve(await physicalStoragePath(parent), basename(path));
  }
}
