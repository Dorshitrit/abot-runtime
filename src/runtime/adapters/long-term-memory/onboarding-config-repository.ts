import { inspectRuntimeConfigFileWithMeta } from "../../config/loader.js";
import type { LongTermMemoryOnboardingConfigRepository } from "../../long-term-memory/onboarding/contracts.js";
import {
  ConfigFileConflictError,
  withConfigFileTransaction,
} from "../config-file-transaction.js";

export function createFileLongTermMemoryOnboardingConfigRepository(params: {
  rootDir: string;
  configPath?: string;
}): LongTermMemoryOnboardingConfigRepository {
  const source = () =>
    inspectRuntimeConfigFileWithMeta(params.rootDir, params.configPath);
  return Object.freeze({
    async read() {
      const current = source();
      if (!current.exists)
        throw new Error(`runtime_config_not_found:${current.path}`);
      return Object.freeze({ config: current.config, path: current.path });
    },
    async write(config, expectedConfig) {
      const current = source();
      if (!current.exists)
        throw new Error(`runtime_config_not_found:${current.path}`);
      try {
        return await withConfigFileTransaction(
          current.path,
          async (transaction) => {
            if (!transaction.snapshot.exists)
              throw new Error(`runtime_config_not_found:${current.path}`);
            const result = await transaction.write(config, { expectedConfig });
            return Object.freeze({
              configPath: transaction.path,
              backupPath: result.backupPath!,
            });
          },
        );
      } catch (error) {
        if (error instanceof ConfigFileConflictError)
          throw new Error("long_term_memory_config_changed");
        throw error;
      }
    },
  });
}
