import { DEFAULT_OLLAMA_URL } from "../../shared/constants.js";
import type {
  ModelProviderAdapterRegistry,
  ModelProviderInvocationError,
} from "../providers/contracts.js";
import { createBuiltInModelProviderAdapterRegistry } from "../providers/registry.js";
import type {
  ModelGatewayEmbeddingResult,
  ModelGatewayPolicyConfig,
} from "../types.js";
import { resolveEmbeddingProfile } from "./profile.js";
import {
  validateEmbeddingModelFingerprint,
  validateEmbeddingVectors,
} from "./validation.js";

export class EmbeddingProviderRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "EmbeddingProviderRequestError";
  }
}

export async function executeEmbeddingRequest(params: {
  profileId: string;
  texts: readonly string[];
  modelPolicy: ModelGatewayPolicyConfig;
  abortSignal: AbortSignal;
  fetchImpl?: typeof fetch;
  providerAdapters?: ModelProviderAdapterRegistry;
  ollamaUrl?: string;
  debugRequestId?: string;
}): Promise<ModelGatewayEmbeddingResult> {
  params.abortSignal.throwIfAborted();
  const profile = resolveEmbeddingProfile({
    profileId: params.profileId,
    modelPolicy: params.modelPolicy,
  });
  const adapter = resolveAdapters(params).resolve(profile.provider);
  if (!adapter.embed) {
    throw new EmbeddingProviderRequestError(
      501,
      "model_provider_embeddings_unsupported",
    );
  }
  const result = await adapter.embed({
    requestBody: {
      profileId: profile.id,
      texts: params.texts,
      modelPolicy: params.modelPolicy,
      ...(params.debugRequestId
        ? { debugRequestId: params.debugRequestId }
        : {}),
    },
    profile,
    texts: params.texts,
    fetchImpl: bindAbortSignal(params.fetchImpl ?? fetch, params.abortSignal),
  });
  if (result.kind === "error") {
    throwProviderError(result);
  }
  const vectors = validateEmbeddingVectors({
    vectors: result.vectors,
    expectedCount: params.texts.length,
  });
  const modelFingerprint = validateEmbeddingModelFingerprint(
    result.modelFingerprint,
  );
  return Object.freeze({
    profileId: profile.id,
    provider: profile.provider,
    model: profile.model,
    modelFingerprint,
    dimensions: vectors[0]?.length ?? 0,
    vectors,
  });
}

function resolveAdapters(params: {
  providerAdapters?: ModelProviderAdapterRegistry;
  ollamaUrl?: string;
}): ModelProviderAdapterRegistry {
  return (
    params.providerAdapters ??
    createBuiltInModelProviderAdapterRegistry({
      ollamaUrl:
        params.ollamaUrl ?? process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    })
  );
}

function bindAbortSignal(
  fetchImpl: typeof fetch,
  abortSignal: AbortSignal,
): typeof fetch {
  return (input, init) => fetchImpl(input, { ...init, signal: abortSignal });
}

function throwProviderError(error: ModelProviderInvocationError): never {
  throw new EmbeddingProviderRequestError(error.statusCode, error.message);
}
