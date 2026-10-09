import { PluginConfigurationError } from "./configuration-store.js";

function settingKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function pluginSettingMatchesDefault(
  value: unknown,
  fallback: unknown,
): boolean {
  if (fallback === null) return true; // A null default supplies no type information.
  if (typeof value === "number" && !Number.isFinite(value)) return false;
  return settingKind(value) === settingKind(fallback);
}

export function requireRetainedPluginSettingTypes(
  pluginId: string,
  defaults: Record<string, unknown>,
  saved?: Record<string, unknown>,
): void {
  if (!saved) return;
  for (const [name, fallback] of Object.entries(defaults)) {
    if (!Object.hasOwn(saved, name)) continue;
    if (pluginSettingMatchesDefault(saved[name], fallback)) continue;
    throw new PluginConfigurationError(
      "invalid_plugin_configuration",
      `Saved setting ${name} for plugin ${pluginId} does not match its current default type. Correct it in Plugins before applying.`,
      409,
    );
  }
}
