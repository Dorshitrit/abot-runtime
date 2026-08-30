import type { ModelGatewayEmbeddingResult } from "../types.js";

export function validateEmbeddingVectors(params: {
  vectors: unknown;
  expectedCount: number;
}): readonly (readonly number[])[] {
  if (!hasExpectedVectorCount(params.vectors, params.expectedCount)) {
    throw new Error("model_gateway_embedding_vector_count_invalid");
  }
  const vectors = params.vectors.map(validateVector);
  const dimensions = vectors[0]?.length ?? 0;
  if (dimensions === 0) {
    throw new Error("model_gateway_embedding_vector_empty");
  }
  if (vectors.some((vector) => vector.length !== dimensions)) {
    throw new Error("model_gateway_embedding_dimensions_inconsistent");
  }
  return Object.freeze(vectors);
}

export function validateEmbeddingModelFingerprint(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("model_gateway_embedding_binding_invalid");
  }
  return value;
}

function hasExpectedVectorCount(
  value: unknown,
  expectedCount: number,
): value is unknown[] {
  return Array.isArray(value) && value.length === expectedCount;
}

export function parseEmbeddingResult(
  value: unknown,
  expectedCount: number,
): ModelGatewayEmbeddingResult {
  const body = readRecord(value);
  const vectors = validateEmbeddingVectors({
    vectors: body.vectors,
    expectedCount,
  });
  const dimensions = body.dimensions;
  if (!Number.isSafeInteger(dimensions) || dimensions !== vectors[0]?.length) {
    throw new Error("model_gateway_embedding_dimensions_invalid");
  }
  const binding = readEmbeddingBinding(body);
  return Object.freeze({
    ...binding,
    dimensions,
    vectors,
  });
}

function validateVector(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("model_gateway_embedding_vector_invalid");
  }
  const vector = value.filter(
    (entry): entry is number =>
      typeof entry === "number" && Number.isFinite(entry),
  );
  if (vector.length !== value.length) {
    throw new Error("model_gateway_embedding_vector_non_finite");
  }
  return Object.freeze(vector);
}

function readEmbeddingBinding(
  body: Record<string, unknown>,
): Pick<
  ModelGatewayEmbeddingResult,
  "profileId" | "provider" | "model" | "modelFingerprint"
> {
  const keys = ["profileId", "provider", "model"] as const;
  const values = keys.map((key) => body[key]);
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("model_gateway_embedding_binding_invalid");
  }
  return {
    profileId: values[0] as string,
    provider: values[1] as string,
    model: values[2] as string,
    modelFingerprint: validateEmbeddingModelFingerprint(body.modelFingerprint),
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("model_gateway_embedding_response_invalid");
}
