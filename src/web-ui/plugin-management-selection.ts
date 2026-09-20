import { ABOT_RUNTIME_EXTENSION } from "../plugin-contract/manifest.js";
import type { DiscoveredAgentPluginManifest } from "../runtime/plugins/discovered-manifest.js";
import { updatePluginCapabilitySelection } from "./plugin-capability-selection.js";
import type { RuntimePluginConfig } from "../runtime/ports.js";
import {
  isPluginToolSelected,
  normalizePluginSelection,
  type PluginSelection,
} from "../runtime/plugins/selection.js";

export function updatePluginSelection(params: {
  current: RuntimePluginConfig;
  pluginId: string;
  capabilityIds: readonly string[];
  capabilityId?: string;
  enabled: boolean;
}): RuntimePluginConfig {
  if (params.capabilityId !== undefined) {
    return updatePluginCapabilitySelection({
      ...params,
      capabilityId: params.capabilityId,
    });
  }
  const { current, pluginId } = params;
  if (!params.enabled) {
    const deny = [...(current.deny ?? [])];
    if (!deny.some((id) => id.trim() === pluginId)) deny.push(pluginId);
    return { ...current, deny };
  }
  const deny = current.deny?.filter((id) => id.trim() !== pluginId);
  const next = { ...current, ...(deny ? { deny } : {}) };
  if (hasAllowedPluginCapability(params)) return next;
  return { ...next, allow: [...(current.allow ?? []), pluginId] };
}

function hasAllowedPluginCapability(params: {
  current: RuntimePluginConfig;
  pluginId: string;
  capabilityIds: readonly string[];
}): boolean {
  const selection = normalizePluginSelection({
    ...params.current,
    enabled: true,
    deny: [],
  });
  return params.capabilityIds.some((toolName) =>
    isPluginToolSelected({ pluginId: params.pluginId, toolName, selection }),
  );
}

function isRequestedSelectionTarget(
  params: {
    pluginId: string;
    capabilityId?: string;
  },
  pluginId: string,
  capabilityId: string,
): boolean {
  if (params.pluginId !== pluginId) return false;
  if (params.capabilityId === undefined) return true;
  return params.capabilityId === capabilityId;
}

function changedSelectionEntries(
  before: PluginSelection,
  after: PluginSelection,
): readonly string[] {
  return ["allow", "deny"].flatMap((key) => {
    const policy = key as "allow" | "deny";
    const removed = before[policy].filter(
      (entry) => !after[policy].includes(entry),
    );
    const added = after[policy].filter(
      (entry) => !before[policy].includes(entry),
    );
    return [...removed, ...added];
  });
}

function selectorMatchesOtherCapability(params: {
  changedEntries: readonly string[];
  pluginId: string;
  toolName: string;
}): boolean {
  return params.changedEntries.some((entry) =>
    isPluginToolSelected({
      pluginId: params.pluginId,
      toolName: params.toolName,
      selection: { enabled: true, allow: [entry], deny: [] },
    }),
  );
}

export function pluginSelectionEscapesRequestedScope(params: {
  manifests: readonly DiscoveredAgentPluginManifest[];
  pluginId: string;
  capabilityId?: string;
  before: RuntimePluginConfig;
  after: RuntimePluginConfig;
}): boolean {
  const before = normalizePluginSelection(params.before);
  const after = normalizePluginSelection(params.after);
  const changedEntries = changedSelectionEntries(before, after);
  return params.manifests.some((plugin) => {
    const pluginId = plugin.manifest.name;
    const capabilityIds = Object.keys(
      plugin.manifest.extensions[ABOT_RUNTIME_EXTENSION].capabilities,
    );
    return capabilityIds.some((toolName) => {
      if (isRequestedSelectionTarget(params, pluginId, toolName)) return false;
      if (
        selectorMatchesOtherCapability({ changedEntries, pluginId, toolName })
      ) {
        return true;
      }
      return (
        isPluginToolSelected({ pluginId, toolName, selection: before }) !==
        isPluginToolSelected({ pluginId, toolName, selection: after })
      );
    });
  });
}
