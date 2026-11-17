import type {
  ModelProviderEmbeddingModelCatalogResult,
  ModelProviderEmbeddingModelDiscoveryParams,
} from "../contracts.js";
import { resolveConfiguredOllamaBaseUrl } from "./base-url.js";
import { readInstalledOllamaModelNames } from "./model-catalog.js";

const METADATA_CONCURRENCY = 4;
const DISCOVERY_TIMEOUT_MS = 10_000;

export async function listOllamaEmbeddingModels(
  params: ModelProviderEmbeddingModelDiscoveryParams,
  fallbackUrl: string,
): Promise<ModelProviderEmbeddingModelCatalogResult> {
  const baseUrl = resolveConfiguredOllamaBaseUrl(
    params.providerConfig.baseUrl,
    fallbackUrl,
  );
  const deadline = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  const signal = params.abortSignal ? AbortSignal.any([params.abortSignal, deadline]) : deadline;
  const response = await params.fetchImpl(`${baseUrl}/api/tags`, { signal });
  if (!response.ok) {
    return {
      kind: "error",
      statusCode: response.status || 502,
      message: (await response.text()) || "ollama model discovery error",
    };
  }
  const body = await response.json();
  const installed = readInstalledOllamaModelNames(body);
  const models: string[] = [];
  const unverifiedModels: string[] = [];
  for (let offset = 0; offset < installed.length; offset += METADATA_CONCURRENCY) {
    params.abortSignal?.throwIfAborted();
    if (deadline.aborted) {
      return { kind: "listed", models, unverifiedModels: unverifiedModels.concat(installed.slice(offset)) };
    }
    const batch = installed.slice(offset, offset + METADATA_CONCURRENCY);
    const checks = await Promise.all(batch.map(async (model) => ({
      model,
      capability: await inspectEmbeddingCapability(baseUrl, model, signal, params.fetchImpl),
    })));
    models.push(...checks.filter(({ capability }) => capability === "embedding").map(({ model }) => model));
    unverifiedModels.push(...checks.filter(({ capability }) => capability === "unknown").map(({ model }) => model));
  }
  params.abortSignal?.throwIfAborted();
  return Object.freeze({
    kind: "listed" as const,
    models,
    ...(unverifiedModels.length ? { unverifiedModels } : {}),
  });
}

async function inspectEmbeddingCapability(
  baseUrl: string,
  model: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<"embedding" | "unsupported" | "unknown"> {
  try {
    const response = await fetchImpl(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return "unknown";
    }
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.capabilities)) return "unknown";
    if (!body.capabilities.every((capability) => typeof capability === "string")) return "unknown";
    return body.capabilities.includes("embedding") ? "embedding" : "unsupported";
  } catch {
    // An older server or a single unavailable model cannot verify this ID.
    return "unknown";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
