import type { RuntimeConfigFile, RuntimeConfigOptions } from "./types.js";
import { isRecord, readFirstString, readNestedConfigString } from "./utils.js";

export type RuntimeEnvironmentProfileSelection = {
  profileId?: string;
  profile?: Record<string, unknown>;
  basePaths?: Record<string, unknown>;
  profilePaths?: Record<string, unknown>;
};

export function resolveRuntimeEnvironmentProfileSelection(params: {
  config: RuntimeConfigFile;
  env?: RuntimeConfigOptions["env"];
  profileId?: RuntimeConfigOptions["profileId"];
}): RuntimeEnvironmentProfileSelection {
  const environment = isRecord(params.config.environment)
    ? params.config.environment
    : undefined;
  const profiles = isRecord(environment?.profiles)
    ? environment.profiles
    : undefined;
  const topLevelPaths = isRecord(params.config.paths)
    ? params.config.paths
    : undefined;
  const environmentPaths = isRecord(environment?.paths)
    ? environment.paths
    : undefined;
  const basePaths =
    topLevelPaths || environmentPaths
      ? {
          ...(topLevelPaths ?? {}),
          ...(environmentPaths ?? {}),
        }
      : undefined;
  const requestedProfileId =
    params.profileId?.trim() ||
    readFirstString(params.env ?? {}, ["LLM_RUNTIME_PROFILE"]) ||
    readNestedConfigString(environment, "default") ||
    "";
  if (!requestedProfileId) {
    return {
      ...(basePaths ? { basePaths } : {}),
    };
  }
  if (!profiles || !isRecord(profiles[requestedProfileId])) {
    throw new Error(
      `Unknown runtime environment profile: ${requestedProfileId}`,
    );
  }

  const profile = profiles[requestedProfileId] as Record<string, unknown>;
  return {
    profileId: requestedProfileId,
    profile,
    ...(basePaths ? { basePaths } : {}),
    profilePaths: isRecord(profile.paths) ? profile.paths : undefined,
  };
}
