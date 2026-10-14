import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";

export const PLUGIN_DISCOVERY_CATALOG_HEADER = "Tool groups:";

/** Passive discovery: selectable groups first, with plugin descriptions once. */
export function buildPluginDiscoveryCatalogText(
  catalogGroupIds: readonly string[],
  entries: readonly ToolAvailabilityEntry[] = [],
): string {
  const offeredGroups = new Set(catalogGroupIds);
  const toolsByGroup = new Map<string, Map<string, Set<string>>>();
  const descriptions = new Map<string, string>();
  for (const entry of entries) {
    const groupIds = entry.catalogGroups.filter((id) => offeredGroups.has(id));
    if (groupIds.length === 0) continue;
    // The empty owner denotes a native tool, never a fabricated plugin.
    const owner = entry.pluginName ?? "";
    for (const id of groupIds) {
      const owners = toolsByGroup.get(id) ?? new Map<string, Set<string>>();
      const toolNames = owners.get(owner) ?? new Set<string>();
      toolNames.add(entry.toolName);
      owners.set(owner, toolNames);
      toolsByGroup.set(id, owners);
    }
    if (!entry.pluginName) continue;
    const description = descriptions.get(entry.pluginName)
      || formatPluginDiscoveryDescription(entry.pluginDescription);
    if (description) descriptions.set(entry.pluginName, description);
  }
  const hasOfferedToolBindings = toolsByGroup.size > 0;
  if (!hasOfferedToolBindings) {
    return catalogGroupIds.length > 0
      ? `${PLUGIN_DISCOVERY_CATALOG_HEADER} ${catalogGroupIds.join(", ")}`
      : PLUGIN_DISCOVERY_CATALOG_HEADER;
  }
  const groupEntries = [...offeredGroups].sort().map((id) => {
    const owners = toolsByGroup.get(id);
    if (!owners) return id;
    const bindings = [...owners.keys()].sort().map((owner) => {
      const names = [...owners.get(owner)!].sort().map(formatPluginDiscoveryToolName).join(", ");
      return owner ? `${owner} [${names}]` : names;
    });
    return `${id}: ${bindings.join(", ")}`;
  });
  const catalog = `${PLUGIN_DISCOVERY_CATALOG_HEADER} ${groupEntries.join(" | ")}`;
  const pluginDescriptions = [...descriptions.keys()].sort().map((name) =>
    `${name}: ${descriptions.get(name)!}`,
  );
  return pluginDescriptions.length > 0
    ? `${catalog}\nPlugin descriptions: ${pluginDescriptions.join(" | ")}`
    : catalog;
}

function formatPluginDiscoveryToolName(name: string): string {
  return name.replace(/[%\\[\],;:|\s\u0000-\u001f\u007f]/gu,
    (character) => encodeURIComponent(character));
}

function formatPluginDiscoveryDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  const normalized = description.replaceAll("|", "/").replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= 160) return normalized;
  return `${characters.slice(0, 160).join("")}....`;
}
