import { realpathSync, renameSync } from "node:fs";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { ABOT_RUNTIME_EXTENSION } from "../plugin-contract/manifest.js";
import { withConfigFileTransaction } from "../runtime/adapters/config-file-transaction.js";
import { withFileLock } from "../runtime/adapters/long-term-memory/file-lock.js";
import { inspectRuntimeConfigFileWithMeta } from "../runtime/config/loader.js";
import { discoverConfiguredRuntimePluginManifests } from "../runtime/plugins/configured-manifests.js";
import { evictPluginModules } from "../runtime/plugins/module-cache.js";
import {
  installedPluginPackage,
  installedPluginPackageIdentity,
} from "../runtime/plugins/installation/installed-package.js";
import {
  normalizePluginSelection,
  isPluginToolSelected,
} from "../runtime/plugins/selection.js";
import type { RuntimePluginConfig } from "../runtime/ports.js";
import { PluginRemovalActivationError } from "./plugin-removal-error.js";
import type { RuntimeSetupActivation } from "./local-runtime/runtime-setup-input.js";
import {
  getRuntimePluginSnapshot,
  PluginManagementError,
  setRuntimePluginEnabled,
  type PluginManagementOptions,
} from "./plugin-management-service.js";

export type PluginRemovalRuntime = {
  applyConfiguration: (
    expectedRevision: string,
  ) => Promise<RuntimeSetupActivation>;
  requireInactive: (pluginId: string, capabilityIds: readonly string[]) => void;
};

function removablePackage(
  rootDir: string,
  pluginId: string,
  afterSave = false,
) {
  const plugin = discoverConfiguredRuntimePluginManifests(rootDir).find(
    (entry) => entry.manifest.name === pluginId,
  );
  const installed = plugin && installedPluginPackage(rootDir, plugin);
  if (!plugin || !installed)
    throw new PluginManagementError(
      afterSave ? "plugin_changed" : "plugin_not_removable",
      "Only plugins installed from GitHub in this Runtime can be removed.",
      409,
    );
  return {
    ...installed,
    capabilityIds: Object.keys(
      plugin.manifest.extensions[ABOT_RUNTIME_EXTENSION].capabilities,
    ),
  };
}

/** Disable, activate at the owner, then remove while configuration writers are fenced. */
export async function removeRuntimePlugin(
  options: PluginManagementOptions & PluginRemovalRuntime,
  input: unknown,
) {
  const value = input as Record<string, unknown> | null;
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some((key) => key !== "pluginId") ||
    typeof value.pluginId !== "string" ||
    !value.pluginId.trim()
  )
    throw new PluginManagementError(
      "invalid_plugin_removal",
      "Choose an installed plugin to remove.",
    );
  const pluginId = value.pluginId.trim();
  const rootDir = realpathSync(options.rootDir);
  const source = inspectRuntimeConfigFileWithMeta(rootDir, options.configPath);
  if (!source.exists)
    throw new PluginManagementError(
      "runtime_setup_required",
      "Complete Runtime setup before removing plugins.",
      409,
    );
  const configPath = realpathSync(source.path);
  const canonical = {
    rootDir,
    configPath,
    requireMutationIdle: options.requireMutationIdle,
  };
  return withFileLock(join(rootDir, ".abot-plugin-installation"), async () => {
    const original = removablePackage(rootDir, pluginId);
    const expectedRevision = await withConfigFileTransaction(
      configPath,
      async (transaction) => {
        await setRuntimePluginEnabled(
          canonical,
          { pluginId, enabled: false },
          transaction,
        );
        return transaction.snapshot.revision;
      },
    );
    const activation = await options.applyConfiguration(expectedRevision);
    if (activation.status !== "ready")
      return {
        ...getRuntimePluginSnapshot(canonical),
        removed: false,
        activation,
        message:
          "Plugin disable saved. Files are still installed. " +
          (activation.message ?? "Runtime application is required.") +
          " Then choose Remove again.",
      };
    // Apply takes this same lock; acquire it only after activation has completed.
    return withConfigFileTransaction(configPath, async (transaction) => {
      if (transaction.snapshot.revision !== expectedRevision)
        throw new PluginManagementError(
          "config_changed",
          "Configuration changed after the plugin disable. Refresh and try Remove again.",
          409,
        );
      const current = removablePackage(rootDir, pluginId, true);
      if (current.identity !== original.identity)
        throw new PluginManagementError(
          "plugin_changed",
          "The installed plugin changed. Refresh and try again.",
          409,
        );
      const saved = inspectRuntimeConfigFileWithMeta(rootDir, configPath);
      const selection = normalizePluginSelection(
        saved.config.plugins as RuntimePluginConfig | undefined,
      );
      if (
        current.capabilityIds.some((toolName) =>
          isPluginToolSelected({ pluginId, toolName, selection }),
        )
      )
        throw new PluginManagementError(
          "plugin_selection_changed",
          "The plugin was enabled again. Refresh and try again.",
          409,
        );
      const staging = await mkdtemp(join(rootDir, ".abot-plugin-removal-"));
      try {
        // No asynchronous gap between the loaded-owner check and moving the directory.
        options.requireInactive(pluginId, current.capabilityIds);
        const final = removablePackage(rootDir, pluginId, true);
        if (final.identity !== original.identity)
          throw new PluginManagementError(
            "plugin_changed",
            "The installed plugin changed. Refresh and try again.",
            409,
          );
        renameSync(final.path, join(staging, pluginId));
      } catch (error) {
        // Remove only an empty staging directory; never erase an unexpectedly moved object.
        await rmdir(staging).catch(() => undefined);
        throw error;
      }
      if (
        installedPluginPackageIdentity(join(staging, pluginId)) !==
        original.packageIdentity
      )
        throw new PluginManagementError(
          "plugin_changed",
          `The plugin directory changed during removal. Its files were preserved at ${staging}. Refresh before trying again.`,
          409,
        );
      evictPluginModules(original.path);
      // Preserve deny/allow selectors: deleting the last allow rule would enable other plugins.
      let cleanupPending = false;
      try {
        await rm(staging, { recursive: true, force: true });
      } catch {
        cleanupPending = true;
      }
      return {
        ...getRuntimePluginSnapshot(canonical),
        removed: true,
        activation,
        message: cleanupPending
          ? `${pluginId} removed from Plugins. Some files could not be deleted from ${staging}.`
          : `${pluginId} removed.`,
      };
    }).catch((error: unknown) => {
      throw new PluginRemovalActivationError(error, activation);
    });
  });
}
