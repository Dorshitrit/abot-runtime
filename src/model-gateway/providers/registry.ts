import {
  createModelProviderAdapterRegistry,
  type ModelProviderAdapter,
  type ModelProviderAdapterRegistry,
} from "./contracts.js";
import { createOllamaProviderAdapter } from "./ollama/adapter.js";
import { createOpenAIProviderAdapter } from "./openai/adapter.js";

export function createBuiltInModelProviderAdapterRegistry(options: {
  ollamaUrl: string;
  additionalAdapters?: readonly ModelProviderAdapter[];
}): ModelProviderAdapterRegistry {
  return createModelProviderAdapterRegistry([
    createOllamaProviderAdapter({ fallbackUrl: options.ollamaUrl }),
    createOpenAIProviderAdapter(),
    ...(options.additionalAdapters ?? []),
  ]);
}
