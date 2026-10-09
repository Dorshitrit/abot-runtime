import {
  clearRetainedPluginSecrets,
  requireRetainedSecretClearedBeforeReplacement,
} from "./plugin-configuration-retained-secrets.js";
import { pluginSettingMatchesDefault } from "../runtime/plugins/configuration-settings.js";
import { isRecord } from "../runtime/config/utils.js";
import type { PluginConfigurationDeclaration } from "../runtime/plugins/configuration-context.js";
import {
  PluginConfigurationError,
  type PluginLocalConfiguration,
} from "../runtime/plugins/configuration-store.js";

function invalidConfiguration(message: string): never {
  throw new PluginConfigurationError("invalid_plugin_configuration", message);
}

function parseSettings(
  input: unknown,
  declaration: PluginConfigurationDeclaration,
): Record<string, unknown> {
  if (!isRecord(input))
    return invalidConfiguration("Plugin settings must be an object.");
  const defaults = declaration.settings?.defaults ?? {};
  for (const [name, value] of Object.entries(input)) {
    if (!Object.hasOwn(defaults, name))
      return invalidConfiguration(
        "Only declared plugin settings can be edited.",
      );
    if (!pluginSettingMatchesDefault(value, defaults[name]))
      return invalidConfiguration(
        `The value for ${name} must match its default type.`,
      );
  }
  return input;
}

function parseSecretChanges(
  input: unknown,
  declaration: PluginConfigurationDeclaration,
  previous?: PluginLocalConfiguration,
): PluginLocalConfiguration["secrets"] {
  if (!isRecord(input))
    return invalidConfiguration("Plugin secrets must be an object.");
  const declarations = declaration.secrets ?? {};
  const changes = Object.entries(input).map(([name, change]) => {
    if (!Object.hasOwn(declarations, name))
      return invalidConfiguration(
        "Only declared plugin secrets can be edited.",
      );
    requireRetainedSecretClearedBeforeReplacement(name, declaration, previous);
    if (!isRecord(change))
      return invalidConfiguration("Choose how to update each secret.");
    if (change.action === "clear") {
      if (Object.keys(change).length !== 1)
        return invalidConfiguration("Clear accepts no secret value.");
      return [name, { env: declarations[name]!.env, value: null }] as const;
    }
    if (change.action !== "set")
      return invalidConfiguration(
        "A secret change must be set or clear; omit it to keep the current value.",
      );
    if (Object.keys(change).some((key) => !["action", "value"].includes(key)))
      return invalidConfiguration("Unsupported secret change.");
    if (typeof change.value !== "string" || !change.value.trim())
      return invalidConfiguration(
        "Enter a non-empty secret or explicitly clear it.",
      );
    return [
      name,
      { env: declarations[name]!.env, value: change.value },
    ] as const;
  });
  return { ...previous?.secrets, ...Object.fromEntries(changes) };
}

export function parsePluginConfigurationUpdate(
  input: unknown,
  declaration: PluginConfigurationDeclaration,
  previous?: PluginLocalConfiguration,
) {
  if (!isRecord(input))
    return invalidConfiguration("Reload plugin configuration before saving.");
  if (
    Object.keys(input).some(
      (key) =>
        !["revision", "settings", "secrets", "clearRetainedSecrets"].includes(
          key,
        ),
    )
  )
    return invalidConfiguration("Unsupported plugin configuration fields.");
  if (typeof input.revision !== "string" || !input.revision)
    return invalidConfiguration("Reload plugin configuration before saving.");
  if (Buffer.byteLength(JSON.stringify(input)) > 128 * 1024)
    return invalidConfiguration("Plugin configuration is too large.");
  const kept = {
    settings: previous?.settings ?? {},
    secrets: clearRetainedPluginSecrets(
      input.clearRetainedSecrets,
      declaration,
      previous,
    ),
  };
  return {
    revision: input.revision,
    configuration: {
      settings: parseSettings(input.settings, declaration),
      secrets: parseSecretChanges(input.secrets ?? {}, declaration, kept),
    },
  };
}
