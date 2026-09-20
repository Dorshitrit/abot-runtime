import type { RuntimePluginConfig } from "../runtime/ports.js";
import {
  isPluginToolSelected,
  normalizePluginSelection,
  type PluginSelection,
} from "../runtime/plugins/selection.js";

export function pluginParentBlockReason(
  pluginId: string,
  selection: PluginSelection,
): string | undefined {
  if (!selection.enabled) return "Plugins are disabled globally.";
  if (selection.deny.includes("*"))
    return "The global deny rule blocks all plugins.";
  if (selection.deny.includes(pluginId))
    return "Enable this plugin before changing its capabilities.";
  return undefined;
}

export function capabilityPolicyBlockReason(params: {
  pluginId: string;
  capabilityId: string;
  selection: PluginSelection;
}): string | undefined {
  const parentBlock = pluginParentBlockReason(
    params.pluginId,
    params.selection,
  );
  if (parentBlock) return parentBlock;
  if (params.selection.deny.includes(params.capabilityId)) {
    return "A shared capability deny rule blocks this capability. Review the rule in Advanced settings.";
  }
  return undefined;
}

function isCapabilityAllowed(params: {
  current: RuntimePluginConfig;
  pluginId: string;
  capabilityId: string;
}): boolean {
  return isPluginToolSelected({
    pluginId: params.pluginId,
    toolName: params.capabilityId,
    selection: normalizePluginSelection({
      ...params.current,
      enabled: true,
      deny: [],
    }),
  });
}

function addQualifiedCapabilityDeny(
  current: RuntimePluginConfig,
  qualifiedId: string,
): RuntimePluginConfig {
  const deny = [...(current.deny ?? [])];
  const hasQualifiedDeny = deny.some((entry) => entry.trim() === qualifiedId);
  if (hasQualifiedDeny) return { ...current, deny };
  return { ...current, deny: [...deny, qualifiedId] };
}

export function updatePluginCapabilitySelection(params: {
  current: RuntimePluginConfig;
  pluginId: string;
  capabilityId: string;
  enabled: boolean;
}): RuntimePluginConfig {
  const qualifiedId = `${params.pluginId}.${params.capabilityId}`;
  if (!params.enabled) {
    return addQualifiedCapabilityDeny(params.current, qualifiedId);
  }
  const deny = params.current.deny?.filter(
    (entry) => entry.trim() !== qualifiedId,
  );
  const next = { ...params.current, ...(deny ? { deny } : {}) };
  if (isCapabilityAllowed(params)) return next;
  return { ...next, allow: [...(params.current.allow ?? []), qualifiedId] };
}
