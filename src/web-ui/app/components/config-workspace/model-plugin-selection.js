import { isConfigObject } from "./config-model.js";

export function modelPluginRulesNeedRepair(config) {
  if (config.plugins === undefined) return false;
  if (!isConfigObject(config.plugins)) return true;
  if (config.plugins.deny === undefined) return false;
  if (!Array.isArray(config.plugins.deny)) return true;
  return config.plugins.deny.some((value) => typeof value !== "string");
}

function modelDeniedSelectors(config) {
  if (modelPluginRulesNeedRepair(config)) return [];
  return (config.plugins?.deny || []).map((entry) => entry.trim());
}

// Browser projection of the existing deny contract; Runtime remains its enforcer.
function selectorMatchesCapability(selector, pluginId, capabilityId) {
  return (
    selector === "*" ||
    selector === pluginId ||
    selector === capabilityId ||
    selector === `${pluginId}.${capabilityId}`
  );
}

function selectorEscapesModelTarget(plugins, pluginId, capabilityId, selector) {
  return plugins.some((plugin) =>
    (plugin.capabilities || []).some((capability) => {
      if (plugin.id === pluginId && capabilityId === undefined) return false;
      if (plugin.id === pluginId && capability.id === capabilityId)
        return false;
      return selectorMatchesCapability(selector, plugin.id, capability.id);
    }),
  );
}

function modelPluginGlobalBlockReason(plugin) {
  if (plugin.blockedByGlobalPolicy)
    return "Blocked by the global plugin policy.";
  if (plugin.pluginEnabled === false)
    return "Enable this plugin in global plugin settings first.";
  if (plugin.state === "disabled")
    return "No tools are available in global plugin settings.";
  return "";
}

function modelPluginControlBlockReason(config, plugin, plugins, denied) {
  if (modelPluginRulesNeedRepair(config))
    return "Repair this model's plugin restrictions before changing tools.";
  if (denied.includes("*"))
    return "The saved * rule blocks every plugin for this model.";
  const globalReason = modelPluginGlobalBlockReason(plugin);
  if (globalReason) return globalReason;
  if (selectorEscapesModelTarget(plugins, plugin.id, undefined, plugin.id))
    return "This plugin selector also affects tools in another plugin. Review the saved rules.";
  return "";
}

function modelCapabilityControlBlockReason(
  config,
  plugin,
  capability,
  plugins,
  denied,
) {
  if (modelPluginRulesNeedRepair(config))
    return "Repair this model's plugin restrictions before changing tools.";
  if (denied.includes("*"))
    return "The saved * rule blocks every tool for this model.";
  if (denied.includes(plugin.id))
    return "Enable this plugin for the model before changing individual tools.";
  if (denied.includes(capability.id))
    return "A shared tool restriction blocks this tool. Review the saved rules.";
  const globalReason = modelPluginGlobalBlockReason(plugin);
  if (globalReason) return globalReason;
  if (capability.enabled !== true)
    return (
      capability.blockedReason ||
      "This tool is unavailable in global plugin settings."
    );
  const selector = `${plugin.id}.${capability.id}`;
  if (selectorEscapesModelTarget(plugins, plugin.id, capability.id, selector))
    return "This tool selector also affects another tool. Review the saved rules.";
  return "";
}

function modelCapabilityIsEnabled(config, plugin, capability, denied) {
  if (modelPluginRulesNeedRepair(config)) return false;
  if (modelPluginGlobalBlockReason(plugin)) return false;
  if (capability.enabled !== true) return false;
  return !denied.some((selector) =>
    selectorMatchesCapability(selector, plugin.id, capability.id),
  );
}

function modelPluginSelectionState(selectedCount, capabilityCount) {
  if (selectedCount === 0) return "disabled";
  if (selectedCount < capabilityCount) return "partial";
  return "enabled";
}

export function projectModelPluginSelection(config, plugin, plugins) {
  const denied = modelDeniedSelectors(config);
  const capabilities = (plugin.capabilities || []).map((capability) => ({
    ...capability,
    enabled: modelCapabilityIsEnabled(config, plugin, capability, denied),
    blockedReason: modelCapabilityControlBlockReason(
      config,
      plugin,
      capability,
      plugins,
      denied,
    ),
  }));
  const selectedCapabilityCount = capabilities.filter(
    (capability) => capability.enabled,
  ).length;
  return {
    ...plugin,
    // The parent is configured separately from individual tools and global policy.
    pluginEnabled:
      !modelPluginRulesNeedRepair(config) &&
      !denied.includes("*") &&
      !denied.includes(plugin.id),
    capabilities,
    capabilityCount: capabilities.length,
    selectedCapabilityCount,
    state: modelPluginSelectionState(
      selectedCapabilityCount,
      capabilities.length,
    ),
    controlBlockedReason: modelPluginControlBlockReason(
      config,
      plugin,
      plugins,
      denied,
    ),
  };
}

function updateExactModelSelector(config, selector, enabled) {
  const denied = config.plugins?.deny || [];
  const matches = (entry) => entry.trim() === selector;
  if (enabled && !denied.some(matches)) return false;
  if (!enabled && denied.some(matches)) return false;
  const next = enabled
    ? denied.filter((entry) => !matches(entry))
    : [...denied, selector];
  config.plugins = { ...config.plugins, deny: next };
  return true;
}

export function setModelPluginEnabled(config, plugins, pluginId, enabled) {
  const plugin = plugins.find((entry) => entry.id === pluginId);
  if (!plugin) return false;
  const selection = projectModelPluginSelection(config, plugin, plugins);
  if (selection.controlBlockedReason) return false;
  return updateExactModelSelector(config, pluginId, enabled);
}

export function setModelCapabilityEnabled(
  config,
  plugins,
  pluginId,
  capabilityId,
  enabled,
) {
  const plugin = plugins.find((entry) => entry.id === pluginId);
  if (!plugin) return false;
  const selection = projectModelPluginSelection(config, plugin, plugins);
  const capability = selection.capabilities.find(
    (entry) => entry.id === capabilityId,
  );
  if (!capability || capability.blockedReason) return false;
  return updateExactModelSelector(
    config,
    `${pluginId}.${capabilityId}`,
    enabled,
  );
}
