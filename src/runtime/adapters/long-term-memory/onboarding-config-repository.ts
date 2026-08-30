import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { inspectRuntimeConfigFileWithMeta } from "../../config/loader.js";
import type { RuntimeConfigFile } from "../../config/types.js";
import type { LongTermMemoryOnboardingConfigRepository } from "../../long-term-memory/onboarding/contracts.js";
import { withFileLock } from "./file-lock.js";

export function createFileLongTermMemoryOnboardingConfigRepository(params: {
  rootDir: string;
  configPath?: string;
}): LongTermMemoryOnboardingConfigRepository {
  const source = () =>
    inspectRuntimeConfigFileWithMeta(params.rootDir, params.configPath);
  return Object.freeze({
    async read() {
      const current = source();
      if (!current.exists) {
        throw new Error(`runtime_config_not_found:${current.path}`);
      }
      return Object.freeze({ config: current.config, path: current.path });
    },
    async write(config, expectedConfig) {
      const current = source();
      if (!current.exists) {
        throw new Error(`runtime_config_not_found:${current.path}`);
      }
      return withFileLock(
        `${current.path}.memory-onboarding.lock`,
        async () => {
          const lockedCurrent = source();
          if (!lockedCurrent.exists) {
            throw new Error(`runtime_config_not_found:${lockedCurrent.path}`);
          }
          const hasConflictingConfig =
            expectedConfig !== undefined &&
            !isDeepStrictEqual(lockedCurrent.config, expectedConfig);
          if (hasConflictingConfig) {
            throw new Error("long_term_memory_config_changed");
          }
          return writeConfigSnapshot(lockedCurrent.path, config);
        },
      );
    },
  });
}

async function writeConfigSnapshot(
  configPath: string,
  config: RuntimeConfigFile,
): Promise<Readonly<{ configPath: string; backupPath: string }>> {
  await mkdir(dirname(configPath), { recursive: true });
  const backupPath = createBackupPath(configPath);
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  const sourcePermissions = (await stat(configPath)).mode & 0o777;
  await copyFile(configPath, backupPath);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: sourcePermissions,
    });
    await chmod(temporaryPath, sourcePermissions);
    await rename(temporaryPath, configPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return Object.freeze({ configPath, backupPath });
}

function createBackupPath(configPath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return `${configPath}.${timestamp}.bak`;
}
