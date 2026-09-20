import { ABOT_RUNTIME_EXTENSION } from "../plugin-contract/manifest.js";
import type { RuntimePluginConfig } from "../runtime/ports.js";
import type { DiscoveredAgentPluginManifest } from "../runtime/plugins/discovered-manifest.js";
import {
  isPluginToolSelected,
  normalizePluginSelection,
  type PluginSelection,
} from "../runtime/plugins/selection.js";
import {
  capabilityPolicyBlockReason,
  pluginParentBlockReason,
} from "./plugin-capability-selection.js";

export type RuntimePluginCapabilitySnapshot = {
  id: string;
  description: string;
  enabled: boolean;
  blockedByPolicy: boolean;
  blockedReason?: string;
};

export type RuntimePluginSnapshot = {
  selection: PluginSelection;
  plugins: Array<{
    id: string;
    description?: string;
    version?: string;
    pluginEnabled: boolean;
    capabilities: RuntimePluginCapabilitySnapshot[];
    capabilityCount: number;
    selectedCapabilityCount: number;
    state: "enabled" | "partial" | "disabled";
    blockedByGlobalPolicy: boolean;
  }>;
  application: "restart_required";
};

function pluginState(
  selectedCount: number,
  capabilityCount: number,
): "enabled" | "partial" | "disabled" {
  if (selectedCount === 0) return "disabled";
  if (selectedCount < capabilityCount) return "partial";
  return "enabled";
}

function isPluginSelectionGloballyBlocked(selection: PluginSelection): boolean {
  if (!selection.enabled) return true;
  return selection.deny.includes("*");
}

function projectPluginCapabilities(
  plugin: DiscoveredAgentPluginManifest,
  selection: PluginSelection,
): RuntimePluginCapabilitySnapshot[] {
  const pluginId = plugin.manifest.name;
  return Object.entries(
    plugin.manifest.extensions[ABOT_RUNTIME_EXTENSION].capabilities,
  ).map(([id, capability]) => {
    const blockedReason = capabilityPolicyBlockReason({
      pluginId,
      capabilityId: id,
      selection,
    });
    return {
      id,
      description: capability.description,
      enabled: isPluginToolSelected({ pluginId, toolName: id, selection }),
      blockedByPolicy: blockedReason !== undefined,
      ...(blockedReason ? { blockedReason } : {}),
    };
  });
}

export function projectPluginSnapshot(
  manifests: readonly DiscoveredAgentPluginManifest[],
  config: RuntimePluginConfig,
): RuntimePluginSnapshot {
  const selection = normalizePluginSelection(config);
  return {
    selection,
    plugins: manifests.map((plugin) => {
      const manifest = plugin.manifest;
      const capabilities = projectPluginCapabilities(plugin, selection);
      const capabilityCount = capabilities.length;
      const selectedCapabilityCount = capabilities.filter(
        (capability) => capability.enabled,
      ).length;
      return {
        id: manifest.name,
        ...(manifest.description ? { description: manifest.description } : {}),
        ...(manifest.version ? { version: manifest.version } : {}),
        pluginEnabled:
          pluginParentBlockReason(manifest.name, selection) === undefined,
        capabilities,
        capabilityCount,
        selectedCapabilityCount,
        state: pluginState(selectedCapabilityCount, capabilityCount),
        blockedByGlobalPolicy: isPluginSelectionGloballyBlocked(selection),
      };
    }),
    application: "restart_required",
  };
}
