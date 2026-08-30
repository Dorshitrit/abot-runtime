import { createEmbeddingModelFingerprint } from "../../embeddings/fingerprint.js";
import { validateEmbeddingVectors } from "../../embeddings/validation.js";
import type {
  ModelProviderEmbeddingParams,
  ModelProviderEmbeddingResult,
} from "../contracts.js";
import { resolveConfiguredOllamaBaseUrl } from "./base-url.js";

export async function embedWithOllama(
  params: ModelProviderEmbeddingParams,
  fallbackUrl: string,
): Promise<ModelProviderEmbeddingResult> {
  const baseUrl = resolveConfiguredOllamaBaseUrl(
    params.profile.providerConfig.baseUrl,
    fallbackUrl,
  );
  const response = await params.fetchImpl(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: params.profile.model,
      input: params.texts,
      ...(params.profile.options &&
      Object.keys(params.profile.options).length > 0
        ? { options: params.profile.options }
        : {}),
      ...(params.profile.providerConfig.keepAlive
        ? { keep_alive: params.profile.providerConfig.keepAlive }
        : {}),
    }),
  });
  if (!response.ok) {
    return {
      kind: "error",
      statusCode: response.status || 502,
      message: (await response.text()) || "ollama embedding error",
    };
  }
  const body = await response.json().catch(() => undefined);
  const embeddings = readEmbeddings(body);
  return Object.freeze({
    kind: "embedded" as const,
    vectors: validateEmbeddingVectors({
      vectors: embeddings,
      expectedCount: params.texts.length,
    }),
    modelFingerprint: createEmbeddingModelFingerprint(params.profile, baseUrl),
  });
}

function readEmbeddings(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).embeddings
    : undefined;
}
