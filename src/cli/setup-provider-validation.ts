import { createBuiltInModelProviderAdapterRegistry } from "../model-gateway/providers/registry.js";
import { DEFAULT_OLLAMA_URL } from "../shared/constants.js";

/** The packaged CLI hosts built-ins; source/library hosts may inject other adapters. */
export function requirePackagedSetupProvider(provider: string, commandMode: string): void {
  if (commandMode !== "package") return;
  const available = createBuiltInModelProviderAdapterRegistry({ ollamaUrl: DEFAULT_OLLAMA_URL })
    .list().map((adapter) => adapter.type);
  if (available.includes(provider)) return;
  throw new Error(`Unknown provider adapter '${provider}'. Available in abot: ${available.join(", ")}.`);
}
