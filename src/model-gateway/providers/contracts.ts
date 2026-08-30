import type {
  ModelGatewayEmbeddingRequest,
  ModelGatewayEvent,
  ModelGatewayProviderConfig,
  ModelGatewayRequest,
  ResolvedEmbeddingProfile,
  ResolvedModelInvocation,
} from "../types.js";

export type ModelProviderEventSink = Readonly<{
  emit(event: ModelGatewayEvent): void;
}>;

export type ModelProviderInvocationError = Readonly<{
  kind: "error";
  statusCode: number;
  message: string;
}>;

export type ModelProviderChatInvocation = Readonly<{
  kind: "chat";
  stream(events: ModelProviderEventSink): Promise<void>;
}>;

export type ModelProviderRawInvocation = Readonly<{
  kind: "raw";
  body: Record<string, unknown>;
}>;

export type ModelProviderInvocationResult =
  | ModelProviderInvocationError
  | ModelProviderChatInvocation
  | ModelProviderRawInvocation;

export type ModelProviderInputTokenCount = Readonly<{
  kind: "counted";
  inputTokens: number;
  providerEnvelopeFingerprint: string;
}>;

export type ModelProviderInputTokenMeasurement = Readonly<{
  inputTokens: number;
  providerEnvelopeFingerprint: string;
  source: "provider_input_token_count";
}>;

export type ModelProviderInputTokenCountResult =
  | ModelProviderInvocationError
  | ModelProviderInputTokenCount;

export type ModelProviderEmbeddingResult =
  | ModelProviderInvocationError
  | Readonly<{
      kind: "embedded";
      vectors: readonly (readonly number[])[];
      modelFingerprint: string;
    }>;

export type ModelProviderEmbeddingParams = Readonly<{
  requestBody: ModelGatewayEmbeddingRequest;
  profile: ResolvedEmbeddingProfile;
  texts: readonly string[];
  fetchImpl: typeof fetch;
}>;

export type ModelProviderEmbeddingModelCatalog = Readonly<{
  supported: boolean;
  models: readonly string[];
}>;

export type ModelProviderEmbeddingModelDiscoveryParams = Readonly<{
  providerId: string;
  providerConfig: ModelGatewayProviderConfig;
  fetchImpl: typeof fetch;
}>;

export type ModelProviderEmbeddingModelCatalogResult =
  | ModelProviderInvocationError
  | Readonly<{ kind: "listed"; models: readonly string[] }>;

export type ModelProviderInvocationParams = Readonly<{
  endpoint: "chat" | "raw";
  requestBody: ModelGatewayRequest;
  invocation: ResolvedModelInvocation;
  fetchImpl: typeof fetch;
  inputTokenMeasurement?: ModelProviderInputTokenMeasurement;
}>;

export type ModelProviderInputTokenCountParams = Readonly<{
  endpoint: "chat" | "raw";
  requestBody: ModelGatewayRequest;
  invocation: ResolvedModelInvocation;
  fetchImpl: typeof fetch;
}>;

/**
 * Owns one provider protocol. The gateway core selects an adapter and never
 * branches on provider-specific payload, authentication or stream semantics.
 */
export type ModelProviderAdapter = Readonly<{
  type: string;
  supportsImageInput: boolean;
  embed?(
    params: ModelProviderEmbeddingParams,
  ): Promise<ModelProviderEmbeddingResult>;
  listEmbeddingModels?(
    params: ModelProviderEmbeddingModelDiscoveryParams,
  ): Promise<ModelProviderEmbeddingModelCatalogResult>;
  countInputTokens?(
    params: ModelProviderInputTokenCountParams,
  ): Promise<ModelProviderInputTokenCountResult>;
  invoke(
    params: ModelProviderInvocationParams,
  ): Promise<ModelProviderInvocationResult>;
}>;

export class ModelProviderAdapterResolutionError extends Error {
  readonly statusCode = 400;
  readonly code = "unknown_model_provider_adapter";

  constructor(providerType: string) {
    super(`unknown_model_provider_adapter: ${providerType}`);
    this.name = "ModelProviderAdapterResolutionError";
  }
}

export type ModelProviderAdapterRegistry = Readonly<{
  list(): readonly ModelProviderAdapter[];
  resolve(providerType: string): ModelProviderAdapter;
}>;

export function createModelProviderAdapterRegistry(
  adapters: readonly ModelProviderAdapter[],
): ModelProviderAdapterRegistry {
  const byType = new Map<string, ModelProviderAdapter>();
  for (const adapter of adapters) {
    const type = adapter.type.trim();
    if (!type) {
      throw new TypeError("model_provider_adapter_type_required");
    }
    if (byType.has(type)) {
      throw new TypeError(`model_provider_adapter_duplicate:${type}`);
    }
    byType.set(type, Object.freeze({ ...adapter, type }));
  }
  const catalog = Object.freeze([...byType.values()]);
  return Object.freeze({
    list: () => catalog,
    resolve(providerType: string) {
      const adapter = byType.get(providerType.trim());
      if (!adapter) {
        throw new ModelProviderAdapterResolutionError(providerType);
      }
      return adapter;
    },
  });
}
