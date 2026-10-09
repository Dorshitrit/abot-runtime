import type { RuntimePluginConfig } from "../runtime/ports.js";

/** Update only the exact plugin-ID block; leave all tool policy untouched. */
export function updatePluginDisabledIds(params: {
  current: RuntimePluginConfig;
  pluginId: string;
  enabled: boolean;
}): RuntimePluginConfig {
  const { current, pluginId, enabled } = params;
  const disabledPluginIds = current.disabledPluginIds ?? [];
  if (enabled) {
    const { disabledPluginIds: _disabled, ...settings } = current;
    const remaining = disabledPluginIds.filter((id) => id.trim() !== pluginId);
    return {
      ...settings,
      ...(remaining.length ? { disabledPluginIds: remaining } : {}),
    };
  }
  const alreadyDisabled = disabledPluginIds.some(
    (id) => id.trim() === pluginId,
  );
  if (alreadyDisabled) return current;
  return { ...current, disabledPluginIds: [...disabledPluginIds, pluginId] };
}
