import { isRecord } from "../runtime/config/utils.js";
import type { PluginConfigurationDeclaration } from "../runtime/plugins/configuration-context.js";
import {
  PluginConfigurationError,
  type PluginLocalConfiguration,
} from "../runtime/plugins/configuration-store.js";

function isDeclaredSecretBinding(
  declaration: PluginConfigurationDeclaration,
  name: string,
  env: string,
): boolean {
  const secrets = declaration.secrets ?? {};
  if (!Object.hasOwn(secrets, name)) return false;
  return secrets[name]!.env === env;
}

export function retainedPluginSecrets(
  declaration: PluginConfigurationDeclaration,
  local?: PluginLocalConfiguration,
) {
  return Object.entries(local?.secrets ?? {})
    .filter(
      ([name, saved]) => !isDeclaredSecretBinding(declaration, name, saved.env),
    )
    .map(([name, saved]) => ({
      name,
      env: saved.env,
      configured: Boolean(saved.value?.trim()),
    }));
}

function invalidRetainedSecretChange(message: string): never {
  throw new PluginConfigurationError("invalid_plugin_configuration", message);
}

export function clearRetainedPluginSecrets(
  input: unknown,
  declaration: PluginConfigurationDeclaration,
  previous?: PluginLocalConfiguration,
): PluginLocalConfiguration["secrets"] {
  const kept = { ...previous?.secrets };
  if (input === undefined) return kept;
  if (!Array.isArray(input))
    return invalidRetainedSecretChange(
      "Choose which unused saved keys to delete.",
    );
  for (const entry of input) {
    if (!isRecord(entry))
      return invalidRetainedSecretChange(
        "Choose an unused saved key to delete.",
      );
    if (Object.keys(entry).some((key) => !["name", "env"].includes(key)))
      return invalidRetainedSecretChange(
        "An unused key removal accepts only its name and environment binding.",
      );
    if (typeof entry.name !== "string" || typeof entry.env !== "string")
      return invalidRetainedSecretChange(
        "An unused key removal requires its name and environment binding.",
      );
    if (!Object.hasOwn(kept, entry.name) || kept[entry.name]!.env !== entry.env)
      return invalidRetainedSecretChange(
        "The unused saved key changed. Reload the form before deleting it.",
      );
    if (isDeclaredSecretBinding(declaration, entry.name, entry.env))
      return invalidRetainedSecretChange(
        "Use the declared key's Clear value action to clear it.",
      );
    delete kept[entry.name];
  }
  return kept;
}

export function requireRetainedSecretClearedBeforeReplacement(
  name: string,
  declaration: PluginConfigurationDeclaration,
  previous?: PluginLocalConfiguration,
): void {
  if (!previous || !Object.hasOwn(previous.secrets, name)) return;
  if (isDeclaredSecretBinding(declaration, name, previous.secrets[name]!.env))
    return;
  throw new PluginConfigurationError(
    "invalid_plugin_configuration",
    `Delete the unused saved key ${name} explicitly before configuring its new environment binding.`,
  );
}
