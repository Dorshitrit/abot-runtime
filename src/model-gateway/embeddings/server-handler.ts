import { traceDebug } from "../../runtime/observability/debug-logger.js";
import type { ModelGatewayEmbeddingRequest } from "../types.js";
import type {
  GatewayResponse,
  ModelGatewayHandlerOptions,
  ModelGatewayInvocationContext,
} from "../server/contracts.js";
import { respondToGatewayHandlerError } from "../server/errors.js";
import { sendJson } from "../server/http-response.js";
import { MAX_MODEL_GATEWAY_EMBEDDING_BATCH_SIZE } from "./constants.js";
import { executeEmbeddingRequest } from "./execution.js";

export function createEmbeddingHandler(
  options: ModelGatewayHandlerOptions = {},
) {
  const { fetchImpl = fetch, modelPolicy } = options;

  return async function embeddingHandler(
    requestBody: ModelGatewayEmbeddingRequest,
    response: GatewayResponse,
    context: ModelGatewayInvocationContext = {},
  ): Promise<void> {
    const abortSignal = context.abortSignal ?? new AbortController().signal;
    try {
      abortSignal.throwIfAborted();
      const texts = readEmbeddingTexts(requestBody.texts);
      const effectivePolicy = modelPolicy ?? requestBody.modelPolicy;
      const startedAt = Date.now();
      const result = await executeEmbeddingRequest({
        profileId: readProfileId(requestBody.profileId),
        texts,
        modelPolicy: effectivePolicy ?? {},
        abortSignal,
        fetchImpl,
        ...(options.providerAdapters
          ? { providerAdapters: options.providerAdapters }
          : {}),
        ...(options.ollamaUrl ? { ollamaUrl: options.ollamaUrl } : {}),
        ...(typeof requestBody.debugRequestId === "string"
          ? { debugRequestId: requestBody.debugRequestId }
          : {}),
      });
      if (abortSignal.aborted) {
        return;
      }
      emitEmbeddingCompleted({
        requestBody,
        profileId: result.profileId,
        provider: result.provider,
        model: result.model,
        vectorCount: result.vectors.length,
        dimensions: result.dimensions,
        durationMs: Date.now() - startedAt,
      });
      return sendJson(response, 200, result);
    } catch (error) {
      respondToGatewayHandlerError({
        error,
        response,
        abortSignal,
        includeContextWindowErrors: false,
      });
    }
  };
}

function readEmbeddingTexts(value: unknown): readonly string[] {
  const texts = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
  const hasInvalidEntry =
    !Array.isArray(value) ||
    texts.length !== value.length ||
    texts.some(isBlank);
  if (hasInvalidEntry || texts.length === 0) {
    throw new EmbeddingRequestValidationError("embedding_texts_required");
  }
  if (texts.length > MAX_MODEL_GATEWAY_EMBEDDING_BATCH_SIZE) {
    throw new EmbeddingRequestValidationError("embedding_batch_too_large");
  }
  return Object.freeze([...texts]);
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function emitEmbeddingCompleted(params: {
  requestBody: ModelGatewayEmbeddingRequest;
  profileId: string;
  provider: string;
  model: string;
  vectorCount: number;
  dimensions: number;
  durationMs: number;
}): void {
  traceDebug("model-gateway.server", "embedding.completed", {
    requestId:
      typeof params.requestBody.debugRequestId === "string"
        ? params.requestBody.debugRequestId
        : "",
    profileId: params.profileId,
    provider: params.provider,
    model: params.model,
    vectorCount: params.vectorCount,
    dimensions: params.dimensions,
    durationMs: params.durationMs,
  });
}

class EmbeddingRequestValidationError extends Error {
  readonly statusCode = 400;
}

function readProfileId(value: unknown): string {
  return typeof value === "string" ? value : "";
}
