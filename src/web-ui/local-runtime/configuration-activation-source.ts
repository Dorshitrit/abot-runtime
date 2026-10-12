import { requireRuntimeSetupEditSettled } from "./runtime-setup-edit-recovery.js";
import { withPluginConfigurationLock } from "../../runtime/plugins/configuration-write.js";
import {
  ConfigFileConflictError,
  withConfigFileTransaction,
} from "../../runtime/adapters/config-file-transaction.js";
import { resolveRequestRunnerConfigReference } from "../../runtime/config/request-runner-config.js";
import { invalidateRequestRunnerConfig } from "../../runtime/config/runner/loader.js";
import type { RuntimeSetupActivation } from "./runtime-setup-input.js";

export type ConfigurationActivationPreparation = {
  prepareConfiguration(): void;
  restoreConfiguration(): void;
};

function restoreUnappliedRequestRunner(
  activation: RuntimeSetupActivation,
  preparation: ConfigurationActivationPreparation,
): void {
  if (activation.status === "ready") return;
  preparation.restoreConfiguration();
}

/** Cooperating root and linked-file saves wait for activation or restoration to finish. */
export function withConfigurationActivationSource(
  configPath: string,
  operation: (
    preparation: ConfigurationActivationPreparation,
  ) => Promise<RuntimeSetupActivation>,
  expectedRevision?: string,
  pluginRootDir?: string,
): Promise<RuntimeSetupActivation> {
  return withConfigFileTransaction(configPath, async (transaction) => {
    requireRuntimeSetupEditSettled(pluginRootDir ?? process.cwd());
    if (
      expectedRevision !== undefined &&
      transaction.snapshot.revision !== expectedRevision
    )
      throw new ConfigFileConflictError();
    const runner = resolveRequestRunnerConfigReference({
      fileConfig: transaction.snapshot.config,
      mainConfigPath: configPath,
    });
    let restoreRequestRunner = () => {};
    const preparation: ConfigurationActivationPreparation = {
      prepareConfiguration() {
        if (runner)
          restoreRequestRunner = invalidateRequestRunnerConfig(runner);
      },
      restoreConfiguration() {
        restoreRequestRunner();
      },
    };
    try {
      const activation = await (pluginRootDir
        ? withPluginConfigurationLock(pluginRootDir, () =>
            operation(preparation),
          )
        : operation(preparation));
      restoreUnappliedRequestRunner(activation, preparation);
      return activation;
    } catch (error) {
      preparation.restoreConfiguration();
      throw error;
    }
  });
}
