import { vi } from "vitest";
import type { BasketSnapshot, StoredBasketSource } from "../../information-basket/index-records.js";
import { createBasketStateOwner } from "../../information-basket/state-owner.js";

export function healthSource(number: number): StoredBasketSource {
  return {
    sourceId: `basket-00000000-0000-0000-0000-${String(number).padStart(12, "0")}`,
    displayName: `source-${number}.txt`, path: `/source-${number}.txt`, revision: 1,
    status: "ready", sizeBytes: 5, chunkCount: 1, indexedAt: "2026-10-26T00:00:00Z", reason: null,
    index: {
      contentHash: "a".repeat(64), fileIdentity: "1:2:5:4:5", chunkingVersion: 1,
      totalCharacters: 5, profileSignature: "fixture", modelFingerprint: "fixture-v1", dimensions: 2,
      chunks: [{ chunkId: "chunk-0", startChar: 0, endChar: 5, vector: [1, 0] }],
    },
  };
}

export async function healthState(count = 1) {
  let stored: BasketSnapshot = {
    schemaVersion: 1, hostNamespace: "fixture",
    settings: { revision: 1, enabled: true, embeddingProfileId: "fixture" },
    sources: Array.from({ length: count }, (_, index) => healthSource(index)),
  };
  const update = vi.fn(async (change: (state: BasketSnapshot) => BasketSnapshot) => {
    stored = change(stored);
    return stored;
  });
  const state = createBasketStateOwner({ read: async () => stored, update });
  await state.read();
  return { state, update, sources: stored.sources };
}
