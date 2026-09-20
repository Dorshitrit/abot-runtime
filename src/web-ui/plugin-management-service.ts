import { realpathSync } from "node:fs";
import {
  ConfigFileConflictError,
  withConfigFileTransaction,
  type ConfigFileTransaction,
} from "../runtime/adapters/config-file-transaction.js";
import { inspectRuntimeConfigFileWithMeta } from "../runtime/config/loader.js";
import { isRecord } from "../runtime/config/utils.js";
import { validatePluginConfig } from "../runtime/config/validation/runtime-root-section-validation.js";
import type { RuntimePluginConfig } from "../runtime/ports.js";
import { ABOT_RUNTIME_EXTENSION } from "../plugin-contract/manifest.js";
import type { DiscoveredAgentPluginManifest } from "../runtime/plugins/discovered-manifest.js";
import { discoverConfiguredRuntimePluginManifests } from "../runtime/plugins/configured-manifests.js";
import { normalizePluginSelection } from "../runtime/plugins/selection.js";
import { capabilityPolicyBlockReason } from "./plugin-capability-selection.js";
import {
  projectPluginSnapshot,
  type RuntimePluginSnapshot,
} from "./plugin-management-catalog.js";
export type { RuntimePluginSnapshot } from "./plugin-management-catalog.js";
import { saveConfigDashboardFile } from "./config-dashboard-backend.js";
import {
  pluginSelectionEscapesRequestedScope,
  updatePluginSelection,
} from "./plugin-management-selection.js";

export type PluginManagementOptions = {
  rootDir: string;
  configPath?: string;
};

export class PluginManagementError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

function readPluginSelection(value: unknown): RuntimePluginConfig {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new PluginManagementError(
      "invalid_plugin_configuration",
      "The plugin configuration must be an object.",
    );
  }
  const issues: string[] = [];
  validatePluginConfig(issues, value);
  if (issues.length > 0) {
    throw new PluginManagementError(
      "invalid_plugin_configuration",
      "The plugin configuration is invalid. Review it in Advanced settings.",
    );
  }
  return value as RuntimePluginConfig;
}

export function getRuntimePluginSnapshot(
  options: PluginManagementOptions,
): RuntimePluginSnapshot {
  const source = inspectRuntimeConfigFileWithMeta(
    options.rootDir,
    options.configPath,
  );
  return projectPluginSnapshot(
    discoverConfiguredRuntimePluginManifests(options.rootDir),
    readPluginSelection(source.config.plugins),
  );
}

function isPluginSelectionIdentifier(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value.trim().length > 0;
}

function parsePluginToggle(input: unknown): {
  pluginId: string;
  capabilityId?: string;
  enabled: boolean;
} {
  if (!isRecord(input))
    throw new PluginManagementError(
      "invalid_plugin_update",
      "Choose a plugin and whether it should be enabled.",
    );
  const hasUnsupportedSelectionFields = Object.keys(input).some(
    (key) => !["pluginId", "capabilityId", "enabled"].includes(key),
  );
  if (hasUnsupportedSelectionFields) {
    throw new PluginManagementError(
      "invalid_plugin_update",
      "The plugin update contains unsupported fields.",
    );
  }
  if (!isPluginSelectionIdentifier(input.pluginId)) {
    throw new PluginManagementError(
      "invalid_plugin_update",
      "A plugin ID is required.",
    );
  }
  if (typeof input.enabled !== "boolean") {
    throw new PluginManagementError(
      "invalid_plugin_update",
      "The enabled value must be true or false.",
    );
  }
  if (input.capabilityId === undefined) {
    return { pluginId: input.pluginId.trim(), enabled: input.enabled };
  }
  if (!isPluginSelectionIdentifier(input.capabilityId)) {
    throw new PluginManagementError(
      "invalid_plugin_update",
      "A capability ID must be a non-empty string.",
    );
  }
  return {
    pluginId: input.pluginId.trim(),
    capabilityId: input.capabilityId.trim(),
    enabled: input.enabled,
  };
}

function requireCapabilityUpdateAllowed(
  plugin: DiscoveredAgentPluginManifest,
  toggle: { capabilityId?: string; enabled: boolean },
  current: RuntimePluginConfig,
): void {
  const capabilityId = toggle.capabilityId;
  if (capabilityId === undefined) return;
  const capabilities =
    plugin.manifest.extensions[ABOT_RUNTIME_EXTENSION].capabilities;
  const isDeclaredCapability = Object.hasOwn(capabilities, capabilityId);
  if (!isDeclaredCapability) {
    throw new PluginManagementError(
      "plugin_capability_not_found",
      "The selected capability does not belong to this plugin.",
      404,
    );
  }
  if (!toggle.enabled) return;
  const blockedReason = capabilityPolicyBlockReason({
    pluginId: plugin.manifest.name,
    capabilityId,
    selection: normalizePluginSelection(current),
  });
  if (!blockedReason) return;
  throw new PluginManagementError(
    "plugin_capability_blocked",
    blockedReason,
    409,
  );
}

function configuredPluginSource(options: PluginManagementOptions) {
  const source = inspectRuntimeConfigFileWithMeta(
    options.rootDir,
    options.configPath,
  );
  if (!source.exists) {
    throw new PluginManagementError(
      "runtime_setup_required",
      "Complete Runtime setup before changing plugins.",
      409,
    );
  }
  return source;
}

export async function setRuntimePluginEnabled(
  options: PluginManagementOptions,
  input: unknown,
) {
  const toggle = parsePluginToggle(input);
  const source = configuredPluginSource(options);
  const configPath = realpathSync(source.path);
  const canonicalOptions = {
    rootDir: realpathSync(options.rootDir),
    configPath,
  };
  try {
    return await withConfigFileTransaction(configPath, (transaction) =>
      savePluginSelection(canonicalOptions, toggle, transaction),
    );
  } catch (error) {
    if (error instanceof ConfigFileConflictError)
      throw new PluginManagementError("config_changed", error.message, 409);
    throw error;
  }
}

async function savePluginSelection(
  options: PluginManagementOptions,
  toggle: ReturnType<typeof parsePluginToggle>,
  transaction: ConfigFileTransaction,
) {
  const source = configuredPluginSource(options);
  const manifests = discoverConfiguredRuntimePluginManifests(options.rootDir);
  const plugin = manifests.find(
    (entry) => entry.manifest.name === toggle.pluginId,
  );
  if (!plugin)
    throw new PluginManagementError(
      "plugin_not_found",
      "The selected plugin is not installed.",
      404,
    );
  const current = readPluginSelection(source.config.plugins);
  const capabilityId = toggle.capabilityId;
  requireCapabilityUpdateAllowed(plugin, toggle, current);
  const next = updatePluginSelection({
    current,
    ...(capabilityId ? { capabilityId } : {}),
    pluginId: toggle.pluginId,
    capabilityIds: Object.keys(
      plugin.manifest.extensions[ABOT_RUNTIME_EXTENSION].capabilities,
    ),
    enabled: toggle.enabled,
  });
  const escapesRequestedScope = pluginSelectionEscapesRequestedScope({
    manifests,
    pluginId: toggle.pluginId,
    ...(capabilityId ? { capabilityId } : {}),
    before: current,
    after: next,
  });
  if (escapesRequestedScope) {
    throw new PluginManagementError(
      "plugin_selection_conflict",
      "This selection would also change other capabilities. Review the selection in Advanced settings.",
      409,
    );
  }
  const result = await saveConfigDashboardFile({
    ...options,
    kind: "runtime",
    config: { ...source.config, plugins: next },
    transaction,
  });
  return {
    ...projectPluginSnapshot(manifests, next),
    restartRequired: true,
    ...(result.backupPath ? { backupPath: result.backupPath } : {}),
  };
}
