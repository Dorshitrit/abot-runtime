import type {
  ModelProviderEmbeddingModelCatalogResult,
  ModelProviderEmbeddingModelDiscoveryParams,
} from "../contracts.js";
import { resolveConfiguredOllamaBaseUrl } from "./base-url.js";

export async function listOllamaEmbeddingModels(
  params: ModelProviderEmbeddingModelDiscoveryParams,
  fallbackUrl: string,
): Promise<ModelProviderEmbeddingModelCatalogResult> {
  const baseUrl = resolveConfiguredOllamaBaseUrl(
    params.providerConfig.baseUrl,
    fallbackUrl,
  );
  const response = await params.fetchImpl(`${baseUrl}/api/tags`);
  if (!response.ok) {
    return {
      kind: "error",
      statusCode: response.status || 502,
      message: (await response.text()) || "ollama model discovery error",
    };
  }
  const body = await response.json().catch(() => undefined);
  return Object.freeze({
    kind: "listed" as const,
    models: readModelNames(body),
  });
}

function readModelNames(value: unknown): readonly string[] {
  const body = isRecord(value) ? value : undefined;
  const models = Array.isArray(body?.models) ? body.models : [];
  return models.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    return name ? [name] : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
