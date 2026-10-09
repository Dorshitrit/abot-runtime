import { matchesToolSelectionId } from "../../shared/tool-selection.js";
import type { RuntimePluginConfig } from "../ports.js";

export type PluginSelection = Readonly<{
  enabled: boolean;
  allow: readonly string[];
  deny: readonly string[];
  disabledPluginIds: readonly string[];
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
    disabledPluginIds: Object.freeze(uniqueSorted(config?.disabledPluginIds)),
  });
}

export function pluginSelectionCacheKey(selection: PluginSelection): string {
  return JSON.stringify([
    selection.enabled,
    selection.allow,
    selection.deny,
    selection.disabledPluginIds,
  ]);
}

export function isPluginDisabledById(
  pluginId: string,
  selection: PluginSelection,
): boolean {
  return selection.disabledPluginIds.includes(pluginId);
}

export function isPluginCatalogDisabled(selection: PluginSelection): boolean {
  if (!selection.enabled) return true;
  return selection.deny.includes("*");
}

export function isPluginToolSelected(params: {
  pluginId: string;
  toolName: string;
  selection: PluginSelection;
}): boolean {
  if (!params.selection.enabled) return false;
  if (isPluginDisabledById(params.pluginId, params.selection)) return false;
  if (
    params.selection.allow.length > 0 &&
    !params.selection.allow.some((entry) =>
      matchesToolSelectionId(params.pluginId, params.toolName, entry),
    )
  ) {
    return false;
  }
  return !params.selection.deny.some((entry) =>
    matchesToolSelectionId(params.pluginId, params.toolName, entry),
  );
}
