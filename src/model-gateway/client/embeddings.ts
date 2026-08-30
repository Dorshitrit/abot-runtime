import { traceDebug } from "../../runtime/observability/debug-logger.js";
import { parseEmbeddingResult } from "../embeddings/validation.js";
import type {
  ModelGatewayEmbeddingParams,
  ModelGatewayEmbeddingResult,
} from "../types.js";
import type { ModelGatewayClientOptions } from "./contracts.js";
import { resolveClientOptions } from "./options.js";

export async function embedModelGatewayWithOptions(
  params: ModelGatewayEmbeddingParams,
  options: ModelGatewayClientOptions = {},
): Promise<ModelGatewayEmbeddingResult> {
  const clientOptions = resolveClientOptions(options);
  const profileId = params.profileId.trim();
  if (!profileId || params.texts.length === 0) {
    throw new Error("model_gateway_embedding_request_invalid");
  }
  const requestId = params.debugRequestId?.trim() ?? "";
  const startedAt = Date.now();
  traceDebug("model-gateway.client", "embedding.request.start", {
    requestId,
    profileId,
    inputCount: params.texts.length,
  });
  const response = await fetch(`${clientOptions.baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: params.abortSignal,
    body: JSON.stringify({
      profileId,
      texts: params.texts,
      ...(requestId ? { debugRequestId: requestId } : {}),
      ...((params.modelPolicy ?? clientOptions.modelPolicy)
        ? { modelPolicy: params.modelPolicy ?? clientOptions.modelPolicy }
        : {}),
    }),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `bridge_embedding_failed:${response.status}:${errorText || "empty error body"}`,
    );
  }
  const result = parseEmbeddingResult(
    await response.json().catch(() => undefined),
    params.texts.length,
  );
  if (result.profileId !== profileId) {
    throw new Error("model_gateway_embedding_profile_mismatch");
  }
  traceDebug("model-gateway.client", "embedding.request.completed", {
    requestId,
    profileId,
    provider: result.provider,
    model: result.model,
    vectorCount: result.vectors.length,
    dimensions: result.dimensions,
    durationMs: Date.now() - startedAt,
  });
  return result;
}
