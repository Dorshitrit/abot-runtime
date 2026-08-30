import { describe, expect, test } from "vitest";

import type {
  LongTermMemoryEmbeddingClient,
  LongTermMemoryEmbeddingResult,
} from "../long-term-memory/contracts.js";
import { embedLongTermMemoryTexts } from "../long-term-memory/embedding-batches.js";

describe("long-term memory embedding batches", () => {
  test.each([
    {
      name: "blank fingerprint",
      result: { modelFingerprint: " ", dimensions: 2, vectors: [[1, 0]] },
    },
    {
      name: "non-positive dimensions",
      result: { modelFingerprint: "fixture", dimensions: 0, vectors: [[]] },
    },
    {
      name: "unsafe dimensions",
      result: {
        modelFingerprint: "fixture",
        dimensions: Number.MAX_SAFE_INTEGER + 1,
        vectors: [[1, 0]],
      },
    },
    {
      name: "vector dimension mismatch",
      result: { modelFingerprint: "fixture", dimensions: 2, vectors: [[1]] },
    },
    {
      name: "non-finite vector component",
      result: {
        modelFingerprint: "fixture",
        dimensions: 2,
        vectors: [[1, Number.POSITIVE_INFINITY]],
      },
    },
  ])("rejects a $name", async ({ result }) => {
    await expect(
      embedTexts(createEmbeddingClient(result), ["memory"]),
    ).rejects.toThrow("long_term_memory_embedding_response_invalid");
  });

  test("rejects inconsistent vector dimensions within one batch", async () => {
    await expect(
      embedTexts(
        createEmbeddingClient({
          modelFingerprint: "fixture",
          dimensions: 2,
          vectors: [[1, 0], [1]],
        }),
        ["first", "second"],
      ),
    ).rejects.toThrow("long_term_memory_embedding_response_invalid");
  });

  test("returns validated immutable vector copies", async () => {
    const sourceVector = [1, 0];
    const embedded = await embedTexts(
      createEmbeddingClient({
        modelFingerprint: "fixture",
        dimensions: 2,
        vectors: [sourceVector],
      }),
      ["memory"],
    );

    sourceVector[0] = 0;
    expect(embedded.vectors).toEqual([[1, 0]]);
    expect(Object.isFrozen(embedded.vectors[0])).toBe(true);
  });
});

function createEmbeddingClient(
  result: LongTermMemoryEmbeddingResult,
): LongTermMemoryEmbeddingClient {
  return Object.freeze({
    async embed() {
      return result;
    },
  });
}

function embedTexts(
  embeddings: LongTermMemoryEmbeddingClient,
  texts: readonly string[],
): Promise<LongTermMemoryEmbeddingResult> {
  return embedLongTermMemoryTexts({
    embeddings,
    texts,
    abortSignal: new AbortController().signal,
  });
}
