import { requireRetainedPluginSettingTypes } from "./configuration-settings.js";
import type { RuntimePluginLoadContext } from "../../plugin-contract/entrypoint.js";
import type { AbotRuntimePluginExtension } from "../../plugin-contract/manifest.js";
import type { PluginLocalConfiguration } from "./configuration-store.js";

export type PluginConfigurationDeclaration = Pick<
  AbotRuntimePluginExtension,
  "settings" | "secrets"
>;

export function effectivePluginSettings(
  declaration: PluginConfigurationDeclaration,
  local?: PluginLocalConfiguration,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(declaration.settings?.defaults ?? {}).map(
      ([name, fallback]) => [
        name,
        structuredClone(
          local && Object.hasOwn(local.settings, name)
            ? local.settings[name]
            : fallback,
        ),
      ],
    ),
  );
}

export function configuredPluginSecret(
  name: string,
  declaration: { env: string },
  local?: PluginLocalConfiguration,
): string | undefined {
  const saved = local?.secrets[name];
  if (saved?.env === declaration.env)
    return saved.value?.trim() ? saved.value : undefined;
  const inherited = process.env[declaration.env];
  return inherited?.trim() ? inherited : undefined;
}

export function pluginLoadConfiguration(
  pluginId: string,
  declaration: PluginConfigurationDeclaration,
  local?: PluginLocalConfiguration,
): Pick<RuntimePluginLoadContext, "config" | "secrets"> {
  requireRetainedPluginSettingTypes(
    pluginId,
    declaration.settings?.defaults ?? {},
    local?.settings,
  );
  const declarations = declaration.secrets ?? {};
  for (const [name, secret] of Object.entries(declarations)) {
    if (!secret.required) continue;
    if (configuredPluginSecret(name, secret, local)) continue;
    throw new Error(
      `Runtime plugin ${pluginId} requires secret ${name} from environment variable ${secret.env}`,
    );
  }
  const secrets = Object.keys(declarations).length
    ? Object.freeze({
        get(name: string): string | undefined {
          if (!Object.hasOwn(declarations, name))
            throw new Error(
              `Runtime plugin ${pluginId} requested undeclared secret ${name}`,
            );
          return configuredPluginSecret(name, declarations[name]!, local);
        },
      })
    : undefined;
  return {
    ...(declaration.settings
      ? { config: effectivePluginSettings(declaration, local) }
      : {}),
    ...(secrets ? { secrets } : {}),
  };
}
