import type { RuntimePluginConfig } from "../ports.js";

export type PluginSelection = Readonly<{
  enabled: boolean;
  allow: readonly string[];
  deny: readonly string[];
}>;

function uniqueSorted(values: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export function normalizePluginSelection(
  config: RuntimePluginConfig | undefined,
): PluginSelection {
  return Object.freeze({
    enabled: config?.enabled !== false,
    allow: Object.freeze(uniqueSorted(config?.allow)),
    deny: Object.freeze(uniqueSorted(config?.deny)),
  });
}

export function pluginSelectionCacheKey(selection: PluginSelection): string {
  return JSON.stringify([selection.enabled, selection.allow, selection.deny]);
}

export function isPluginCatalogDisabled(selection: PluginSelection): boolean {
  if (!selection.enabled) return true;
  return selection.deny.includes("*");
}

function matchesPluginToolId(
  pluginId: string,
  toolName: string,
  configuredId: string,
): boolean {
  return (
    configuredId === "*" ||
    configuredId === pluginId ||
    configuredId === toolName ||
    configuredId === `${pluginId}.${toolName}`
  );
}

export function isPluginToolSelected(params: {
  pluginId: string;
  toolName: string;
  selection: PluginSelection;
}): boolean {
  if (!params.selection.enabled) {
    return false;
  }
  if (
    params.selection.allow.length > 0 &&
    !params.selection.allow.some((entry) =>
      matchesPluginToolId(params.pluginId, params.toolName, entry),
    )
  ) {
    return false;
  }
  return !params.selection.deny.some((entry) =>
    matchesPluginToolId(params.pluginId, params.toolName, entry),
  );
}
