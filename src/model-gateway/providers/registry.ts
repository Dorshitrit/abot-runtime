import {
  createModelProviderAdapterRegistry,
  type ModelProviderAdapter,
  type ModelProviderAdapterRegistry,
} from "./contracts.js";
import { createLlamaCppProviderAdapter } from "./llamacpp/adapter.js";
import { createOllamaProviderAdapter } from "./ollama/adapter.js";
import { createOpenAIProviderAdapter } from "./openai/adapter.js";
import { createChatGptProviderAdapter } from "./openai-chatgpt/adapter.js";

export function createBuiltInModelProviderAdapterRegistry(options: {
  ollamaUrl: string;
  fetchImpl?: typeof fetch;
  additionalAdapters?: readonly ModelProviderAdapter[];
}): ModelProviderAdapterRegistry {
  return createModelProviderAdapterRegistry([
    createOllamaProviderAdapter({ fallbackUrl: options.ollamaUrl }),
    createOpenAIProviderAdapter(),
    createChatGptProviderAdapter(),
    createLlamaCppProviderAdapter(options.fetchImpl),
    ...(options.additionalAdapters ?? []),
  ]);
}
