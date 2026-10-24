import { createEmbeddingModelFingerprint } from "../../embeddings/fingerprint.js";
import { validateEmbeddingVectors } from "../../embeddings/validation.js";
import { readOpenAiCompatibleEmbeddingVectors } from "../../protocol/openai-embedding-response.js";
import type {
  ModelProviderEmbeddingParams,
  ModelProviderEmbeddingResult,
} from "../contracts.js";
import { resolveLlamaCppProviderSettings } from "./settings.js";

export async function embedWithLlamaCpp(
  params: ModelProviderEmbeddingParams,
): Promise<ModelProviderEmbeddingResult> {
  let settings: ReturnType<typeof resolveLlamaCppProviderSettings>;
  try {
    settings = resolveLlamaCppProviderSettings(params.profile.providerConfig);
  } catch (error) {
    return {
      kind: "error",
      statusCode: 500,
      message: error instanceof Error ? error.message : "llamacpp_configuration_invalid",
    };
  }
  const response = await params.fetchImpl(`${settings.apiUrl}/embeddings`, {
    method: "POST",
    headers: settings.headers,
    body: JSON.stringify({
      ...params.profile.options,
      model: params.profile.model,
      input: params.texts,
      encoding_format: "float",
    }),
  });
  if (!response.ok) {
    return {
      kind: "error",
      statusCode: response.status || 502,
      message: (await response.text()) || "llamacpp embedding error",
    };
  }
  const body = await response.json().catch((error: unknown) => {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  });
  const vectors = readLlamaCppEmbeddingVectors(body, params.texts.length);
  return Object.freeze({
    kind: "embedded",
    vectors: validateEmbeddingVectors({
      vectors,
      expectedCount: params.texts.length,
    }),
    modelFingerprint: createEmbeddingModelFingerprint(params.profile, settings.apiUrl),
  });
}

function readLlamaCppEmbeddingVectors(
  value: unknown,
  expectedCount: number,
): unknown[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length !== expectedCount) return [];
  return readOpenAiCompatibleEmbeddingVectors(value, expectedCount);
}
