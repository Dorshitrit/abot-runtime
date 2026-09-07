import { createHash } from "node:crypto";
import { join } from "node:path";
import type { RuntimeEnvironmentProfileSelection } from "./environment.js";
import { requireLegacyRuntimeStorageAssignment } from "./environment-storage.js";
import { DEFAULT_RUNTIME_STATE_DIR } from "./layout.js";
import type { RuntimeConfigFile, RuntimeConfigOptions } from "./types.js";
import {
  readFirstString,
  readNestedConfigString,
  resolveRuntimePath,
} from "./utils.js";

/** Resolves inherited bases once so every environment-owned adapter shares the namespace. */
export function resolveEnvironmentRuntimeDirectory(params: {
  rootDir: string;
  env: RuntimeConfigOptions["env"];
  config: RuntimeConfigFile;
  configPath: string;
  selection: RuntimeEnvironmentProfileSelection;
}): string {
  const override = readFirstString(params.env ?? {}, ["LLM_RUNTIME_DIR"]);
  const profileDirectory = readNestedConfigString(
    params.selection.profilePaths,
    "runtimeDir",
  );
  const baseDirectory = readNestedConfigString(
    params.selection.basePaths,
    "runtimeDir",
  );
  const directory = resolveRuntimePath(
    params.rootDir,
    override ?? profileDirectory ?? baseDirectory ?? DEFAULT_RUNTIME_STATE_DIR,
  );
  if (!params.selection.profileId) return directory;
  if (usesExplicitEnvironmentDirectory(override, profileDirectory))
    return directory;
  requireLegacyRuntimeStorageAssignment({
    rootDir: params.rootDir,
    baseDir: directory,
    config: params.config,
    configPath: params.configPath,
    environmentOverride: override !== undefined,
  });
  // Hash only the stable ID: safe for arbitrary IDs and case-insensitive filesystems.
  const namespace = createHash("sha256")
    .update(params.selection.profileId)
    .digest("hex");
  return join(directory, "environments", namespace);
}

function usesExplicitEnvironmentDirectory(
  override: string | undefined,
  profileDirectory: string | undefined,
): boolean {
  return override === undefined && profileDirectory !== undefined;
}
