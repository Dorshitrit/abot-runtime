import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadRuntimeConfig } from "../src/runtime/config.js";
import { RUNTIME_LOGS_DIR_NAME } from "../src/runtime/config/layout.js";
import type { RuntimePaths } from "../src/runtime/ports.js";
import {
  isRecord,
  readJsonObject,
  type JsonObject,
} from "./runtime-setup-files.js";

function configuredEnvironmentIds(
  config: JsonObject,
): Array<string | undefined> {
  if (!isRecord(config.environment)) return [undefined];
  if (!isRecord(config.environment.profiles)) return [undefined];
  const profileIds = Object.keys(config.environment.profiles);
  const hasConfiguredEnvironments = profileIds.length > 0;
  return hasConfiguredEnvironments ? profileIds : [undefined];
}

function runtimeOwnedDirectories(paths: RuntimePaths): string[] {
  return [
    paths.runtimeDir,
    paths.agentWorkDir,
    paths.sessionsDir,
    paths.attachmentsDir,
    paths.sharedDir,
    paths.compiledDir,
    dirname(paths.traceFile),
    join(paths.sharedDir, RUNTIME_LOGS_DIR_NAME),
  ];
}

/** Initialize the preserved configuration's output roots without moving existing state. */
export async function initializeConfiguredRuntimeDirectories(
  rootDir: string,
  configPath: string,
): Promise<string[]> {
  const config = await readJsonObject(configPath);
  // Resolve every environment before creating any directories. This preserves the
  // canonical guard against silently reassigning existing shared runtime state.
  const configurations = configuredEnvironmentIds(config).map((profileId) =>
    loadRuntimeConfig({ rootDir, configPath, profileId }),
  );
  const directories = [
    ...new Set(
      configurations.flatMap(({ paths }) => runtimeOwnedDirectories(paths)),
    ),
  ];
  await Promise.all(
    directories.map((directory) => mkdir(directory, { recursive: true })),
  );
  return directories;
}
