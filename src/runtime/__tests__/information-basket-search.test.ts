import { rm } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BasketReadResult } from "../information-basket/contracts.js";
import type { BasketSnapshot, StoredBasketSource } from "../information-basket/index-records.js";
import { basketProfileSignature } from "../information-basket/profile-binding.js";
import { createBasketSearch } from "../information-basket/search.js";
import { createBasketStateOwner } from "../information-basket/state-owner.js";
import { createBasketFixture } from "./support/information-basket-fixture.js";

const fixtures: Awaited<ReturnType<typeof createBasketFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.service.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
function source(suffix: string, profileSignature: string): StoredBasketSource {
  return {
    sourceId: "basket-00000000-0000-0000-0000-00000000000" + suffix,
    displayName: "Source " + suffix, path: "/source-" + suffix + ".txt", revision: 1,
    status: "ready", sizeBytes: 5, chunkCount: 1, indexedAt: "2026-10-25T00:00:00Z", reason: null,
    index: {
      contentHash: "a".repeat(64), fileIdentity: "1:2:5:4:5", chunkingVersion: 1,
      totalCharacters: 5, profileSignature, modelFingerprint: "fixture-v1", dimensions: 2,
      chunks: [{ chunkId: "chunk-0", startChar: 0, endChar: 5, vector: [1, 0] }],
    },
  };
}
function read(source: StoredBasketSource): BasketReadResult {
  return {
    sourceId: source.sourceId, expectedRevision: source.revision, path: source.path, displayName: source.displayName,
    contentHash: "a".repeat(64), text: "apple", startChar: 0, endChar: 5, totalCharacters: 5,
    omittedBefore: 0, omittedAfter: 0, nextStartChar: null,
  };
}
describe("Information Basket search final snapshot", () => {
  test.each(["remove", "disable", "profile"] as const)(
    "reconciles %s after one preview returned and while the next is pending",
    async action => {
      const f = await createBasketFixture();
      fixtures.push(f);
      const signature = basketProfileSignature(f.config, "fixture");
      const first = source("1", signature);
      const second = source("2", signature);
      let stored: BasketSnapshot = {
        schemaVersion: 1, hostNamespace: "fixture",
        settings: { revision: 1, enabled: true, embeddingProfileId: "fixture" },
        sources: [first, second],
      };
      const state = createBasketStateOwner({
        read: async () => stored,
        update: async change => { stored = change(stored); return stored; },
      });
      let startedSecond!: () => void;
      const secondStarted = new Promise<void>(resolve => { startedSecond = resolve; });
      let finishSecond!: () => void;
      const secondWait = new Promise<void>(resolve => { finishSecond = resolve; });
      const readSource = vi.fn(async input => {
        if (input.sourceId === first.sourceId) return read(first);
        startedSecond();
        await secondWait;
        return read(second);
      });
      const search = createBasketSearch({ config: f.config, models: { embed: f.embed }, state, readSource,
        validateSources: async () => undefined });
      const pending = search({ query: "apple", includeExcerpts: true, abortSignal: new AbortController().signal });
      await secondStarted;
      await state.update(current => {
        if (action === "remove") return { ...current, sources: [second] };
        return { ...current, settings: {
          ...current.settings, revision: 2,
          enabled: action !== "disable", embeddingProfileId: action === "profile" ? "alternate" : "fixture",
        } };
      });
      finishSecond();
      const result = await pending;
      if (action !== "remove") {
        expect(result).toMatchObject({ status: "unavailable", reason: "basket_search_superseded", sources: [] });
        return;
      }
      expect(result.status).toBe("found");
      expect(result.sources.map(entry => entry.sourceId)).toEqual([second.sourceId]);
      expect(result.sources[0]!.excerpt).toBe("apple");
    },
  );
});
