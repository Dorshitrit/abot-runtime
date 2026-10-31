import { hasInstalledOllamaModel, inspectOllamaModelCatalog } from "../model-gateway/providers/ollama/model-catalog.js";
import { loadRuntimeConfig } from "../runtime/config.js";

export async function warnSavedOllamaModel(options: {
  commandMode: string;
  rootDir: string;
  configPath: string;
  profileId: string;
}): Promise<void> {
  if (options.commandMode !== "package") return;
  let config: ReturnType<typeof loadRuntimeConfig>;
  try {
    config = loadRuntimeConfig({ rootDir: options.rootDir, configPath: options.configPath, env: {} });
  } catch {
    console.warn("Configuration saved. Could not inspect the saved model configuration; check it before chatting.");
    return;
  }
  const profile = config.models?.profiles?.[options.profileId];
  if (!profile?.provider || !profile.model) return;
  const provider = config.models?.providers?.[profile.provider];
  if (provider?.type !== "ollama") return;
  await warnOllamaSetupModel({ commandMode: options.commandMode, provider: provider.type, model: profile.model, baseUrl: provider.baseUrl });
}

/** Optional metadata check: saved configuration remains usable while the provider is offline. */
export async function warnOllamaSetupModel(options: {
  commandMode: string;
  provider: string;
  model: string;
  baseUrl?: string;
}, fetchImpl?: typeof fetch): Promise<void> {
  if (options.commandMode !== "package" || options.provider !== "ollama") return;
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:11434";
  try {
    const models = await inspectOllamaModelCatalog({ baseUrl, fetchImpl });
    if (hasInstalledOllamaModel(models, options.model)) return;
    console.warn(`Configuration saved. Model '${options.model}' is not installed in Ollama at ${baseUrl}. Check the name with ollama list or install it with ollama pull ${options.model}.`);
  } catch {
    console.warn(`Configuration saved. Could not check installed Ollama models at ${baseUrl}. Start Ollama and verify '${options.model}' with ollama list before chatting.`);
  }
}
