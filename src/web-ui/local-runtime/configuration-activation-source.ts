import { withConfigFileTransaction } from "../../runtime/adapters/config-file-transaction.js";
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
): Promise<RuntimeSetupActivation> {
  return withConfigFileTransaction(configPath, async (transaction) => {
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
      const activation = await operation(preparation);
      restoreUnappliedRequestRunner(activation, preparation);
      return activation;
    } catch (error) {
      preparation.restoreConfiguration();
      throw error;
    }
  });
}
