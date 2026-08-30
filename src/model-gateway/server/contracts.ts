import type {
  ModelGatewayEmbeddingRequest,
  ModelGatewayPolicyConfig,
  ModelGatewayRequest,
  ResolvedModelInvocation,
} from "../types.js";
import type {
  ModelProviderAdapter,
  ModelProviderAdapterRegistry,
  ModelProviderInputTokenMeasurement,
} from "../providers/contracts.js";

export type GatewayFetch = typeof fetch;

export type GatewayResponse = {
  statusCode?: number;
  setHeader(name: string, value: string): void;
  write(chunk: string): void;
  end(chunk?: string): void;
};

export type ModelGatewayInvocationContext = Readonly<{
  abortSignal?: AbortSignal;
}>;

export type ModelGatewayHandlerOptions = {
  fetchImpl?: GatewayFetch;
  modelPolicy?: ModelGatewayPolicyConfig;
  ollamaUrl?: string;
  providerAdapters?: ModelProviderAdapterRegistry;
  additionalProviderAdapters?: readonly ModelProviderAdapter[];
  restartHandler?: (
    request: ModelGatewayRestartRequest,
  ) => void | Promise<void>;
};

export type ModelGatewayRestartRequest = {
  reason?: string;
  delayMs: number;
};

export type ModelGatewayRestartResult = {
  accepted: true;
  pid: number;
  reason?: string;
  delayMs: number;
  scheduledAt: string;
  strategy: "process-exit";
};

export type ModelGatewayStatusResult = {
  pid: number;
  uptimeMs: number;
  startedAt: string;
  now: string;
};

export type ProviderRequestAbortScopeParams = Readonly<{
  endpoint: "chat" | "raw" | "input_tokens" | "embeddings";
  requestBody: ModelGatewayRequest | ModelGatewayEmbeddingRequest;
}>;

export type ProviderFetchParams = Readonly<{
    endpoint: "chat" | "raw" | "input_tokens";
    requestBody: ModelGatewayRequest;
    invocation: ResolvedModelInvocation;
    fetchImpl: typeof fetch;
    abortSignal: AbortSignal;
    inputTokenMeasurement?: ModelProviderInputTokenMeasurement;
  }>;
