import { createFileLongTermMemoryOnboardingConfigRepository } from "../../runtime/adapters/long-term-memory/onboarding-config-repository.js";
import type { LongTermMemoryOnboardingConfigRepository } from "../../runtime/long-term-memory/onboarding/contracts.js";
import { isRecord } from "../../runtime/config/utils.js";
import type { RuntimePluginConfig } from "../../runtime/ports.js";
import { updatePluginSelection } from "../plugin-management-selection.js";

/** Onboarding switches memory implementations in the same guarded config write. */
export function createSetupEmbeddingConfigRepository(params: {
  rootDir: string;
  configPath?: string;
}): LongTermMemoryOnboardingConfigRepository {
  const repository = createFileLongTermMemoryOnboardingConfigRepository(params);
  return Object.freeze({
    read: () => repository.read(),
    write(config, expectedConfig) {
      const enablesNativeMemory =
        isRecord(config.longTermMemory) &&
        config.longTermMemory.enabled === true;
      if (!enablesNativeMemory) return repository.write(config, expectedConfig);

      // The onboarding service validates this candidate before probing and saving.
      const current = (config.plugins ?? {}) as RuntimePluginConfig;
      const plugins = updatePluginSelection({
        current,
        pluginId: "memory",
        capabilityIds: [],
        enabled: false,
      });
      return repository.write({ ...config, plugins }, expectedConfig);
    },
  });
}
