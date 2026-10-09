import { rename, rm } from "node:fs/promises";
import {
  withConfigFileTransaction,
  type ConfigFileTransaction,
} from "../../adapters/config-file-transaction.js";

/** Publish, save selection and roll back under the same lock used by Apply. */
export function publishPluginPackage<T>(options: {
  staging: string;
  target: string;
  pluginId: string;
  configPath: string;
  requireMutationIdle?: () => void;
  saveSelection: (
    pluginId: string,
    transaction: ConfigFileTransaction,
  ) => Promise<T>;
}): Promise<T> {
  return withConfigFileTransaction(options.configPath, async (transaction) => {
    options.requireMutationIdle?.();
    await rename(options.staging, options.target);
    try {
      return await options.saveSelection(options.pluginId, transaction);
    } catch (error) {
      // Apply cannot load the uncommitted package while rollback is in progress.
      await rm(options.target, { recursive: true, force: true });
      throw error;
    }
  });
}
