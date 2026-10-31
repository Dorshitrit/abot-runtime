import { rm } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BasketReadResult } from "../information-basket/contracts.js";
import type { BasketSnapshot, StoredBasketSource } from "../information-basket/index-records.js";
import { basketProfileSignature } from "../information-basket/profile-binding.js";
import { createBasketSearch } from "../information-basket/search.js";
import { createInformationBasketCandidateSource } from "../information-basket/request-candidates.js";
import { RequestToolResources } from "../capabilities/request-tool-resources.js";
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
  test.each(["remove", "disable", "profile", "matchMode"] as const)(
    "reconciles %s after one preview returned and while the next is pending",
    async action => {
      const f = await createBasketFixture();
      fixtures.push(f);
      const signature = basketProfileSignature(f.config, "fixture");
      const first = source("1", signature);
      const second = source("2", signature);
      let stored: BasketSnapshot = {
        schemaVersion: 1, hostNamespace: "fixture",
        settings: { matchMode: "balanced" as const, indexChatUploads: false, revision: 1, enabled: true, embeddingProfileId: "fixture" },
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
          matchMode: action === "matchMode" ? "strict" : "balanced",
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


test.each([
  ["flexible", ["2", "3", "4", "5", "6", "7"]],
  ["balanced", ["4", "5", "6", "7"]],
  ["strict", ["6", "7"]],
] as const)("%s search uses its inclusive threshold without reading source bodies", async (matchMode, suffixes) => {
  const f = await createBasketFixture(); fixtures.push(f);
  const sources = [0.299, 0.3, 0.599, 0.6, 0.899, 0.9, 1].map((score, index) => {
    const entry = source(String(index + 1), basketProfileSignature(f.config, "fixture"));
    return { ...entry, index: { ...entry.index!, chunks: [{ ...entry.index!.chunks[0]!,
      vector: [score, Math.sqrt(1 - score * score)],
    }] } };
  });
  let stored: BasketSnapshot = { schemaVersion: 1, hostNamespace: "fixture", sources,
    settings: { revision: 1, indexChatUploads: false, enabled: true, embeddingProfileId: "fixture", matchMode } };
  const state = createBasketStateOwner({ read: async () => stored,
    update: async change => { stored = change(stored); return stored; } });
  const readSource = vi.fn(async () => read(sources[0]!));
  const validateSources = vi.fn(async (_sources: readonly StoredBasketSource[], _signal: AbortSignal) => undefined);
  const search = createBasketSearch({ config: f.config, models: { embed: f.embed }, state, readSource, validateSources });
  const result = await search({ query: "apple", maxSources: 8, includeExcerpts: false, abortSignal: new AbortController().signal });
  expect(result.sources.map(entry => entry.sourceId.at(-1)).sort()).toEqual(suffixes);
  expect(readSource).not.toHaveBeenCalled();
  expect(validateSources.mock.calls[0]![0]).toHaveLength(suffixes.length);
});


test.each((["flexible", "balanced", "strict"] as const).flatMap(matchMode => [
  { matchMode, query: "נא למצוא את Alex Sample - CV.docx" },
  { matchMode, query: "חפש Alex Sample במסמכים" },
]))(
  "$matchMode prioritizes a name match for $query before the verification window without inflating cosine",
  async ({ matchMode, query }) => {
    const f = await createBasketFixture(); fixtures.push(f);
    const signature = basketProfileSignature(f.config, "fixture");
    const sources = Array.from({ length: 8 }, (_, i) => source(String(i + 1), signature));
    const named = source("9", signature);
    sources.push({ ...named, displayName: "Alex Sample - CV.docx",
      index: { ...named.index!, chunks: [{ ...named.index!.chunks[0]!, vector: [0, 1] }] } });
    let stored: BasketSnapshot = { schemaVersion: 1, hostNamespace: "fixture", sources,
      settings: { revision: 1, indexChatUploads: false, enabled: true, embeddingProfileId: "fixture", matchMode } };
    const state = createBasketStateOwner({ read: async () => stored,
      update: async change => { stored = change(stored); return stored; } });
    const readSource = vi.fn(async () => read(named));
    const validateSources = vi.fn(async (_sources: readonly StoredBasketSource[], _signal: AbortSignal) => undefined);
    const search = createBasketSearch({ config: f.config, models: { embed: f.embed }, state, readSource, validateSources });
    const result = await search({ query, maxSources: 1,
      includeExcerpts: false, abortSignal: new AbortController().signal });
    expect(result).toMatchObject({ status: "found", omittedCount: 7,
      sources: [{ sourceId: named.sourceId, expectedRevision: named.revision, score: 0,
        matches: [{ chunkId: "chunk-0", startChar: 0, endChar: 5 }] }] });
    expect(result.sources).toHaveLength(1);
    expect(validateSources.mock.calls[0]![0]).toHaveLength(8);
    expect(validateSources.mock.calls[0]![0].map(entry => entry.sourceId)).toContain(named.sourceId);
    expect(readSource).not.toHaveBeenCalled();
  },
);

test("duplicate complete names retain separate identities and deterministic ordering", async () => {
  const f = await createBasketFixture(); fixtures.push(f);
  const signature = basketProfileSignature(f.config, "fixture");
  const sources = ["2", "1"].map(suffix => {
    const entry = source(suffix, signature);
    return { ...entry, displayName: "report.pdf",
      index: { ...entry.index!, chunks: [{ ...entry.index!.chunks[0]!, vector: [0, 1] }] } };
  });
  let stored: BasketSnapshot = { schemaVersion: 1, hostNamespace: "fixture", sources,
    settings: { revision: 1, indexChatUploads: false, enabled: true, embeddingProfileId: "fixture", matchMode: "strict" } };
  const state = createBasketStateOwner({ read: async () => stored,
    update: async change => { stored = change(stored); return stored; } });
  const search = createBasketSearch({ config: f.config, models: { embed: f.embed }, state,
    readSource: async () => read(sources[0]!), validateSources: async () => undefined });
  const result = await search({ query: "Find report.pdf.", abortSignal: new AbortController().signal });
  expect(result.sources.map(entry => entry.sourceId)).toEqual([sources[1]!.sourceId, sources[0]!.sourceId]);
  expect(result.sources.map(entry => entry.score)).toEqual([0, 0]);
  expect((await search({ query: "Find report.pdf.bak", abortSignal: new AbortController().signal })).status).toBe("empty");
});

test("a name match still loses admission when source verification invalidates its revision", async () => {
  const f = await createBasketFixture(); fixtures.push(f);
  const entry = source("1", basketProfileSignature(f.config, "fixture"));
  const named = { ...entry, displayName: "report.pdf",
    index: { ...entry.index!, chunks: [{ ...entry.index!.chunks[0]!, vector: [0, 1] }] } };
  let stored: BasketSnapshot = { schemaVersion: 1, hostNamespace: "fixture", sources: [named],
    settings: { revision: 1, indexChatUploads: false, enabled: true, embeddingProfileId: "fixture", matchMode: "strict" } };
  const state = createBasketStateOwner({ read: async () => stored,
    update: async change => { stored = change(stored); return stored; } });
  const validateSources = vi.fn(async () => {
    await state.update(current => ({ ...current, sources: [{ ...named, status: "stale", index: null, chunkCount: 0 }] }));
  });
  const search = createBasketSearch({ config: f.config, models: { embed: f.embed }, state,
    readSource: async () => read(named), validateSources });
  expect(await search({ query: "report.pdf", abortSignal: new AbortController().signal }))
    .toEqual({ status: "empty", sources: [], omittedCount: 0 });
  expect(validateSources).toHaveBeenCalledOnce();
});

test("automatic discovery delivers a low-cosine name match through the existing request candidate source", async () => {
  const f = await createBasketFixture(); fixtures.push(f);
  const entry = source("1", basketProfileSignature(f.config, "fixture"));
  const named = { ...entry, displayName: "quarterly report.pdf",
    index: { ...entry.index!, chunks: [{ ...entry.index!.chunks[0]!, vector: [0, 1] }] } };
  let stored: BasketSnapshot = { schemaVersion: 1, hostNamespace: "fixture", sources: [named],
    settings: { revision: 1, indexChatUploads: false, enabled: true, embeddingProfileId: "fixture", matchMode: "strict" } };
  const state = createBasketStateOwner({ read: async () => stored,
    update: async change => { stored = change(stored); return stored; } });
  const readSource = vi.fn(async () => read(named));
  const search = createBasketSearch({ config: f.config, models: { embed: f.embed }, state,
    readSource, validateSources: async () => undefined });
  const resources = new RequestToolResources();
  const onEvent = vi.fn();
  const candidates = createInformationBasketCandidateSource({
    request: { requestId: "name-discovery", prompt: "Find quarterly report", abortSignal: new AbortController().signal,
      toolResources: resources, onEvent },
    service: { search, subscribeChanges: () => () => undefined },
    getAvailableTools: () => ["search_information_sources", "read_information_source"].map(operationId => ({
      toolName: "information_basket", operationId, summary: "Registered files", catalogGroups: ["knowledge"], effect: "read_only",
    })),
  });
  try {
    await vi.waitFor(() => expect(candidates.getInformationBasketCandidates()).toMatchObject({
      requestId: "name-discovery", result: { status: "found", sources: [{ sourceId: named.sourceId, score: 0 }] },
    }));
    expect(resources.hasActiveWork()).toBe(false);
    expect(readSource).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledOnce();
  } finally {
    await resources.dispose();
  }
});


test("complete file names precede higher-cosine word-sequence matches", async () => {
  const f = await createBasketFixture(); fixtures.push(f);
  const signature = basketProfileSignature(f.config, "fixture");
  const exact = { ...source("1", signature), displayName: "Alex Sample - CV.docx" };
  const partial = { ...source("2", signature), displayName: "Alex Sample notes.txt" };
  const sources = [{ ...exact,
    index: { ...exact.index!, chunks: [{ ...exact.index!.chunks[0]!, vector: [0, 1] }] } }, partial];
  let stored: BasketSnapshot = { schemaVersion: 1, hostNamespace: "fixture", sources,
    settings: { revision: 1, indexChatUploads: false, enabled: true, embeddingProfileId: "fixture", matchMode: "strict" } };
  const state = createBasketStateOwner({ read: async () => stored,
    update: async change => { stored = change(stored); return stored; } });
  const search = createBasketSearch({ config: f.config, models: { embed: f.embed }, state,
    readSource: async () => read(exact), validateSources: async () => undefined });
  const result = await search({ query: "Find Alex Sample - CV.docx", abortSignal: new AbortController().signal });
  expect(result.sources.map(entry => entry.sourceId)).toEqual([exact.sourceId, partial.sourceId]);
  expect(result.sources.map(entry => entry.score)).toEqual([0, 1]);
});
