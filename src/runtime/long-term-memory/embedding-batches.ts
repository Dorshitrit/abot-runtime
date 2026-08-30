import type {
  LongTermMemoryEmbeddingClient,
  LongTermMemoryEmbeddingResult,
} from "./contracts.js";

type ExpectedEmbeddingBinding = Readonly<{
  modelFingerprint: string;
  dimensions: number;
}>;

export async function embedLongTermMemoryTexts(params: {
  embeddings: LongTermMemoryEmbeddingClient;
  texts: readonly string[];
  abortSignal: AbortSignal;
  debugRequestId?: string;
  expectedBinding?: ExpectedEmbeddingBinding;
}): Promise<LongTermMemoryEmbeddingResult> {
  if (params.texts.length === 0) {
    throw new Error("long_term_memory_embedding_input_empty");
  }

  const vectors: (readonly number[])[] = [];
  let binding = params.expectedBinding
    ? validateEmbeddingBinding(params.expectedBinding)
    : undefined;
  const batchSize = resolveEmbeddingBatchSize(
    params.embeddings.maxBatchSize,
    params.texts.length,
  );
  for (let offset = 0; offset < params.texts.length; offset += batchSize) {
    params.abortSignal.throwIfAborted();
    const texts = params.texts.slice(offset, offset + batchSize);
    const embedded = validateEmbeddingResult(
      await params.embeddings.embed({
        texts,
        abortSignal: params.abortSignal,
        ...(params.debugRequestId
          ? { debugRequestId: params.debugRequestId }
          : {}),
      }),
      texts.length,
    );
    binding = bindEmbeddingResult(binding, embedded);
    vectors.push(...embedded.vectors);
  }
  if (!binding) {
    throw new Error("long_term_memory_embedding_input_empty");
  }

  return Object.freeze({
    modelFingerprint: binding.modelFingerprint,
    dimensions: binding.dimensions,
    vectors: Object.freeze(vectors),
  });
}

function resolveEmbeddingBatchSize(
  configuredLimit: number | undefined,
  textCount: number,
): number {
  const validLimit =
    Number.isSafeInteger(configuredLimit) && Number(configuredLimit) > 0;
  return validLimit ? Math.min(Number(configuredLimit), textCount) : textCount;
}

function bindEmbeddingResult(
  expected: ExpectedEmbeddingBinding | undefined,
  actual: ExpectedEmbeddingBinding,
): ExpectedEmbeddingBinding {
  if (!expected) {
    return Object.freeze({
      modelFingerprint: actual.modelFingerprint,
      dimensions: actual.dimensions,
    });
  }
  const bindingChanged =
    actual.modelFingerprint !== expected.modelFingerprint ||
    actual.dimensions !== expected.dimensions;
  if (bindingChanged) {
    throw new Error("long_term_memory_embedding_binding_changed");
  }
  return expected;
}

function validateEmbeddingResult(
  result: LongTermMemoryEmbeddingResult,
  expectedCount: number,
): LongTermMemoryEmbeddingResult {
  const binding = validateEmbeddingBinding(result);
  if (
    !Array.isArray(result.vectors) ||
    result.vectors.length !== expectedCount
  ) {
    throw new Error("long_term_memory_embedding_vector_count_invalid");
  }
  const vectors = result.vectors.map((vector) =>
    validateEmbeddingVector(vector, binding.dimensions),
  );
  return Object.freeze({
    ...binding,
    vectors: Object.freeze(vectors),
  });
}

function validateEmbeddingBinding(
  result: ExpectedEmbeddingBinding,
): ExpectedEmbeddingBinding {
  const validFingerprint =
    typeof result.modelFingerprint === "string" &&
    result.modelFingerprint.trim().length > 0;
  const validDimensions =
    Number.isSafeInteger(result.dimensions) && result.dimensions > 0;
  if (!validFingerprint || !validDimensions) {
    throw new Error("long_term_memory_embedding_response_invalid");
  }
  return Object.freeze({
    modelFingerprint: result.modelFingerprint,
    dimensions: result.dimensions,
  });
}

function validateEmbeddingVector(
  vector: readonly number[],
  expectedDimensions: number,
): readonly number[] {
  if (!Array.isArray(vector) || vector.length !== expectedDimensions) {
    throw new Error("long_term_memory_embedding_response_invalid");
  }
  const validated: number[] = [];
  for (let index = 0; index < vector.length; index += 1) {
    const component = vector[index];
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new Error("long_term_memory_embedding_response_invalid");
    }
    validated.push(component);
  }
  return Object.freeze(validated);
}
