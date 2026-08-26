import { DEFAULT_OLLAMA_URL } from "../../shared/constants.js";
import type { ModelProviderAdapterRegistry } from "../providers/contracts.js";
import { createBuiltInModelProviderAdapterRegistry } from "../providers/registry.js";
import type { ModelGatewayHandlerOptions } from "./contracts.js";

function resolveOllamaUrl(): string {
  return process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL;
}

export function resolveProviderAdapters(
  options: ModelGatewayHandlerOptions,
): ModelProviderAdapterRegistry {
  return (
    options.providerAdapters ??
    createBuiltInModelProviderAdapterRegistry({
      ollamaUrl: options.ollamaUrl ?? resolveOllamaUrl(),
      additionalAdapters: options.additionalProviderAdapters,
    })
  );
}
