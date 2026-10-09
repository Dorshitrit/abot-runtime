import { retainedPluginSecrets } from "./plugin-configuration-retained-secrets.js";
import { createHmac, randomBytes } from "node:crypto";
import {
  configuredPluginSecret,
  effectivePluginSettings,
  type PluginConfigurationDeclaration,
} from "../runtime/plugins/configuration-context.js";
import type {
  PluginConfigurationSnapshot,
  PluginLocalConfiguration,
} from "../runtime/plugins/configuration-store.js";

// Tokens stay stable within this Web process; a restart requires reloading forms.
// The private key prevents browser-visible revisions from verifying secret guesses.
const configurationRevisionKey = randomBytes(32);

export function pluginConfigurationRevision(
  pluginId: string,
  declaration: PluginConfigurationDeclaration,
  store: PluginConfigurationSnapshot,
): string {
  return createHmac("sha256", configurationRevisionKey)
    .update(
      JSON.stringify([
        pluginId,
        declaration.settings?.defaults ?? {},
        declaration.secrets ?? {},
        store.revision,
      ]),
    )
    .digest("hex");
}

/** Password values never enter browser projections, including installation review. */
export function projectPluginConfiguration(
  pluginId: string,
  declaration: PluginConfigurationDeclaration,
  store: PluginConfigurationSnapshot,
) {
  const local = Object.hasOwn(store.plugins, pluginId)
    ? store.plugins[pluginId]
    : undefined;
  return {
    pluginId,
    revision: pluginConfigurationRevision(pluginId, declaration, store),
    scope: "installation" as const,
    defaults: declaration.settings?.defaults ?? {},
    settings: effectivePluginSettings(declaration, local),
    settingOverrides: Object.keys(declaration.settings?.defaults ?? {}).filter(
      (name) => !!local && Object.hasOwn(local.settings, name),
    ),
    retainedSecrets: retainedPluginSecrets(declaration, local),
    secrets: Object.entries(declaration.secrets ?? {}).map(
      ([name, secret]) => ({
        name,
        env: secret.env,
        required: secret.required,
        configured: Boolean(configuredPluginSecret(name, secret, local)),
        locallyConfigured: local?.secrets[name]?.env === secret.env,
      }),
    ),
  };
}

export function hasConfigurablePluginValues(
  declaration: PluginConfigurationDeclaration,
  local?: PluginLocalConfiguration,
): boolean {
  if (Object.keys(declaration.settings?.defaults ?? {}).length > 0) return true;
  if (Object.keys(declaration.secrets ?? {}).length > 0) return true;
  return retainedPluginSecrets(declaration, local).length > 0;
}
