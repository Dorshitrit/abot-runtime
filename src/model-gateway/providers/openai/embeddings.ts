import { createEmbeddingModelFingerprint } from "../../embeddings/fingerprint.js";
import { validateEmbeddingVectors } from "../../embeddings/validation.js";
import type {
  ModelProviderEmbeddingParams,
  ModelProviderEmbeddingResult,
} from "../contracts.js";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function embedWithOpenAI(
  params: ModelProviderEmbeddingParams,
): Promise<ModelProviderEmbeddingResult> {
  const settings = resolveEmbeddingSettings(params);
  if (!settings.apiKey) {
    return {
      kind: "error",
      statusCode: 500,
      message: `missing OpenAI API key env: ${settings.apiKeyEnv}`,
    };
  }
  const response = await params.fetchImpl(`${settings.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
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
      message: (await response.text()) || "openai embedding error",
    };
  }
  const body = await response.json().catch(() => undefined);
  const vectors = readOrderedVectors(body, params.texts.length);
  return Object.freeze({
    kind: "embedded" as const,
    vectors: validateEmbeddingVectors({
      vectors,
      expectedCount: params.texts.length,
    }),
    modelFingerprint: createEmbeddingModelFingerprint(
      params.profile,
      settings.baseUrl,
    ),
  });
}

function resolveEmbeddingSettings(params: ModelProviderEmbeddingParams): {
  baseUrl: string;
  apiKeyEnv: string;
  apiKey?: string;
} {
  const configuredEnv = params.profile.providerConfig.apiKeyEnv?.trim();
  const apiKeyEnv =
    configuredEnv && ENV_VAR_NAME_PATTERN.test(configuredEnv)
      ? configuredEnv
      : DEFAULT_OPENAI_API_KEY_ENV;
  const apiKey = process.env[apiKeyEnv];
  return {
    baseUrl: (
      params.profile.providerConfig.baseUrl?.trim() ||
      process.env.OPENAI_BASE_URL ||
      DEFAULT_OPENAI_BASE_URL
    ).replace(/\/+$/, ""),
    apiKeyEnv,
    ...(apiKey ? { apiKey } : {}),
  };
}

function readOrderedVectors(value: unknown, expectedCount: number): unknown[] {
  const body =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (!body || !Array.isArray(body.data)) {
    return [];
  }
  const entries = body.data.filter(isRecord);
  if (!hasContiguousIndices(entries, expectedCount)) {
    return [];
  }
  return [...entries]
    .sort((left, right) => Number(left.index) - Number(right.index))
    .map((entry) => entry.embedding);
}

function hasContiguousIndices(
  entries: readonly Record<string, unknown>[],
  expectedCount: number,
): boolean {
  if (entries.length !== expectedCount) {
    return false;
  }
  const indices = new Set(entries.map(({ index }) => index));
  return (
    indices.size === expectedCount &&
    [...indices].every(
      (index) =>
        Number.isSafeInteger(index) &&
        Number(index) >= 0 &&
        Number(index) < expectedCount,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
