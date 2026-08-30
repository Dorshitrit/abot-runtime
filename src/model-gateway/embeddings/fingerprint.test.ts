import { describe, expect, test } from "vitest";

import type { ResolvedEmbeddingProfile } from "../types.js";
import { createEmbeddingModelFingerprint } from "./fingerprint.js";

describe("embedding model fingerprint", () => {
  test("is stable across equivalent nested option key order", () => {
    const first = createEmbeddingModelFingerprint(
      createProfile({ alpha: 1, nested: { beta: 2, gamma: [3, { delta: 4 }] } }),
      "https://provider.test/v1",
    );
    const second = createEmbeddingModelFingerprint(
      createProfile({ nested: { gamma: [3, { delta: 4 }], beta: 2 }, alpha: 1 }),
      "https://provider.test/v1/",
    );

    expect(first).toBe(second);
  });
});

function createProfile(options: Record<string, unknown>): ResolvedEmbeddingProfile {
  return Object.freeze({
    id: "memory",
    label: "Memory",
    providerId: "provider",
    provider: "openai",
    providerConfig: Object.freeze({ type: "openai" }),
    model: "embedding-model",
    options: Object.freeze(options),
  });
}
