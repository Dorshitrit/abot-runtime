import { realpathSync } from "node:fs";
import type { ConfigFileTransaction } from "../runtime/adapters/config-file-transaction.js";
import { inspectRuntimeConfigFileWithMeta } from "../runtime/config/loader.js";
import { ABOT_RUNTIME_EXTENSION } from "../plugin-contract/manifest.js";
import { discoverConfiguredRuntimePluginManifests } from "../runtime/plugins/configured-manifests.js";
import {
  configuredPluginSecret,
  type PluginConfigurationDeclaration,
} from "../runtime/plugins/configuration-context.js";
import {
  PluginConfigurationError,
  readPluginConfigurationStore,
  type PluginLocalConfiguration,
} from "../runtime/plugins/configuration-store.js";
import {
  commitPluginConfigurationStore,
  withPluginConfigurationLock,
} from "../runtime/plugins/configuration-write.js";
import { withConfigDashboardRootTransaction } from "./config-dashboard-save-transaction.js";
import type { PluginManagementOptions } from "./plugin-management-service.js";
import { parsePluginConfigurationUpdate } from "./plugin-configuration-input.js";
import {
  pluginConfigurationRevision,
  projectPluginConfiguration,
} from "./plugin-configuration-view.js";

function installedPluginDeclaration(
  rootDir: string,
  pluginId: string,
): PluginConfigurationDeclaration {
  const plugin = discoverConfiguredRuntimePluginManifests(rootDir).find(
    (entry) => entry.manifest.name === pluginId,
  );
  if (!plugin)
    throw new PluginConfigurationError(
      "plugin_not_found",
      "The selected plugin is not installed.",
      404,
    );
  const extension = plugin.manifest.extensions[ABOT_RUNTIME_EXTENSION];
  return { settings: extension.settings, secrets: extension.secrets };
}

export function getRuntimePluginConfiguration(
  options: PluginManagementOptions,
  pluginId: string,
) {
  return projectPluginConfiguration(
    pluginId,
    installedPluginDeclaration(options.rootDir, pluginId),
    readPluginConfigurationStore(options.rootDir),
  );
}

function requireInstallationSecrets(
  declaration: PluginConfigurationDeclaration,
  configuration?: PluginLocalConfiguration,
): void {
  for (const [name, secret] of Object.entries(declaration.secrets ?? {})) {
    if (!secret.required) continue;
    if (configuredPluginSecret(name, secret, configuration)) continue;
    throw new PluginConfigurationError(
      "plugin_secret_required",
      `Configure the required secret ${name} before installing.`,
    );
  }
}

/** Configuration and package selection commit under the same locks as Apply. */
export async function saveRuntimePluginConfiguration<T>(
  options: PluginManagementOptions,
  params: {
    pluginId: string;
    input: unknown;
    transaction?: ConfigFileTransaction;
    installation?: boolean;
    commit?: () => Promise<T>;
  },
) {
  const source = inspectRuntimeConfigFileWithMeta(
    options.rootDir,
    options.configPath,
  );
  if (!source.exists)
    throw new PluginConfigurationError(
      "runtime_setup_required",
      "Complete Runtime setup before configuring plugins.",
      409,
    );
  const rootDir = realpathSync(options.rootDir);
  return withConfigDashboardRootTransaction(
    realpathSync(source.path),
    params.transaction,
    () =>
      withPluginConfigurationLock(rootDir, async () => {
        options.requireMutationIdle?.();
        const declaration = installedPluginDeclaration(
          rootDir,
          params.pluginId,
        );
        const previous = readPluginConfigurationStore(rootDir);
        const local = Object.hasOwn(previous.plugins, params.pluginId)
          ? previous.plugins[params.pluginId]
          : undefined;
        if (params.installation && params.input === undefined) {
          requireInstallationSecrets(declaration, local);
          return {
            result: await params.commit?.(),
            configuration: projectPluginConfiguration(
              params.pluginId,
              declaration,
              previous,
            ),
          };
        }
        const update = parsePluginConfigurationUpdate(
          params.input,
          declaration,
          local,
        );
        if (
          update.revision !==
          pluginConfigurationRevision(params.pluginId, declaration, previous)
        )
          throw new PluginConfigurationError(
            "plugin_configuration_changed",
            "Plugin configuration changed. Reload the form before saving.",
            409,
          );
        if (params.installation)
          requireInstallationSecrets(declaration, update.configuration);
        options.requireMutationIdle?.();
        const result = await commitPluginConfigurationStore(
          rootDir,
          previous,
          {
            ...previous.plugins,
            [params.pluginId]: update.configuration,
          },
          async () => params.commit?.(),
        );
        return {
          result,
          configuration: projectPluginConfiguration(
            params.pluginId,
            declaration,
            readPluginConfigurationStore(rootDir),
          ),
        };
      }),
  );
}
