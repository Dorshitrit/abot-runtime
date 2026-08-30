import { DEFAULT_OLLAMA_URL } from "../../shared/constants.js";
import type {
  ModelProviderAdapterRegistry,
  ModelProviderEmbeddingModelCatalog,
} from "../providers/contracts.js";
import { createBuiltInModelProviderAdapterRegistry } from "../providers/registry.js";
import type { ModelGatewayPolicyConfig } from "../types.js";
import { EmbeddingProviderRequestError } from "./execution.js";

export async function discoverEmbeddingModels(params: {
  providerId: string;
  modelPolicy: ModelGatewayPolicyConfig;
  abortSignal: AbortSignal;
  fetchImpl?: typeof fetch;
  providerAdapters?: ModelProviderAdapterRegistry;
  ollamaUrl?: string;
}): Promise<ModelProviderEmbeddingModelCatalog> {
  params.abortSignal.throwIfAborted();
  const providerId = params.providerId.trim();
  const providerConfig = params.modelPolicy.providers?.[providerId];
  if (!providerConfig) {
    throw new EmbeddingProviderRequestError(
      400,
      `unknown_embedding_provider:${providerId}`,
    );
  }
  const adapter = resolveAdapters(params).resolve(providerConfig.type);
  if (!adapter.listEmbeddingModels) {
    return Object.freeze({ supported: false, models: Object.freeze([]) });
  }
  const result = await adapter.listEmbeddingModels({
    providerId,
    providerConfig,
    fetchImpl: bindAbortSignal(params.fetchImpl ?? fetch, params.abortSignal),
  });
  if (result.kind === "error") {
    throw new EmbeddingProviderRequestError(result.statusCode, result.message);
  }
  return Object.freeze({
    supported: true,
    models: Object.freeze(normalizeModelIds(result.models)),
  });
}

function resolveAdapters(params: {
  providerAdapters?: ModelProviderAdapterRegistry;
  ollamaUrl?: string;
}): ModelProviderAdapterRegistry {
  return (
    params.providerAdapters ??
    createBuiltInModelProviderAdapterRegistry({
      ollamaUrl: params.ollamaUrl ?? process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    })
  );
}

function bindAbortSignal(
  fetchImpl: typeof fetch,
  abortSignal: AbortSignal,
): typeof fetch {
  return (input, init) => fetchImpl(input, { ...init, signal: abortSignal });
}

function normalizeModelIds(models: readonly string[]): readonly string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}
