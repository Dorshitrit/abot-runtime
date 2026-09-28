import { needsComputerSetup } from "../system-host/setup-notice.js";

const suggestions = {
  memory: {
    id: "memory", icon: "memory", title: "Set up passive memory",
    description: "Keep useful context between conversations. Choose an embedding model to get started.",
    action: "Set up memory",
  },
  computer: {
    id: "computer", icon: "computer", title: "Connect your computer",
    description: "Access local apps and tools, with permissions you control.",
    action: "Connect computer",
  },
  plugin: {
    id: "plugin", icon: "memory", title: "Review your memory setup",
    description: "Passive memory is ready. Review whether you still need the separate memory plugin.",
    action: "Review memory plugin",
  },
};

function hasEnabledMemoryPlugin(plugins) {
  const plugin = plugins?.plugins?.find((item) => item.id === "memory");
  if (!plugin || plugin.blockedByGlobalPolicy) return false;
  if (plugin.pluginEnabled === false) return false;
  return plugin.selectedCapabilityCount > 0;
}

export function selectHomeSuggestion({ memory, plugins, connection, dismissed = [] }) {
  const eligible = [];
  if (memory?.enabled === false) eligible.push("memory");
  if (needsComputerSetup(connection)) eligible.push("computer");
  const memoryReady = memory?.enabled === true && memory.available !== false;
  if (memoryReady && hasEnabledMemoryPlugin(plugins)) eligible.push("plugin");
  return suggestions[eligible.find((id) => !dismissed.includes(id))] || null;
}
