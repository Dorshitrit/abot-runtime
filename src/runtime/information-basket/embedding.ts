import type { ModelGatewayClient, RuntimeConfig } from "../ports.js";
import { InformationBasketError, type BasketEmbeddingResult } from "./contracts.js";
import { BASKET_LIMITS } from "./limits.js";
import { awaitBasketWork } from "./work-deadline.js";

export function normalizeBasketVector(vector: readonly number[], dimensions?: number): readonly number[] {
  if (!Array.isArray(vector) || !vector.length || vector.length > BASKET_LIMITS.maxDimensions)
    throw new InformationBasketError("basket_embedding_vector_invalid");
  if (dimensions !== undefined && vector.length !== dimensions)
    throw new InformationBasketError("basket_embedding_binding_changed");
  let magnitude = 0;
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new InformationBasketError("basket_embedding_vector_invalid");
    magnitude += value * value;
  }
  if (!Number.isFinite(magnitude) || magnitude <= 0)
    throw new InformationBasketError("basket_embedding_vector_invalid");
  const length = Math.sqrt(magnitude);
  return Object.freeze(vector.map(value => value / length));
}

export async function embedBasketTexts(params: {
  config: RuntimeConfig;
  models: Pick<ModelGatewayClient, "embed">;
  profileId: string;
  texts: readonly string[];
  abortSignal: AbortSignal;
}): Promise<BasketEmbeddingResult> {
  params.abortSignal.throwIfAborted();
  if (!params.models.embed) throw new InformationBasketError("basket_embedding_unavailable", undefined, 503);
  const signal = AbortSignal.any([params.abortSignal, AbortSignal.timeout(BASKET_LIMITS.embeddingTimeoutMs)]);
  const result = await awaitBasketWork(params.models.embed({
    profileId: params.profileId, texts: params.texts, modelPolicy: params.config.models,
    abortSignal: signal,
  }), signal);
  if (typeof result.modelFingerprint !== "string" || !result.modelFingerprint || result.modelFingerprint.length > 2_048)
    throw new InformationBasketError("basket_embedding_binding_invalid");
  if (!Number.isSafeInteger(result.dimensions) || result.dimensions <= 0)
    throw new InformationBasketError("basket_embedding_binding_invalid");
  if (!Array.isArray(result.vectors) || result.vectors.length !== params.texts.length)
    throw new InformationBasketError("basket_embedding_vector_count_invalid");
  return Object.freeze({
    modelFingerprint: result.modelFingerprint, dimensions: result.dimensions,
    vectors: Object.freeze(result.vectors.map(vector => normalizeBasketVector(vector, result.dimensions))),
  });
}
