import { readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createInformationBasketService } from "../information-basket/service.js";
import { BASKET_LIMITS } from "../information-basket/limits.js";
import { normalizeBasketVector } from "../information-basket/embedding.js";
import { chunkBasketText } from "../information-basket/chunking.js";
import { configureBasket, createBasketFixture, fixtureEmbedding, waitForBasketSource } from "./support/information-basket-fixture.js";
import type { ModelGatewayEmbeddingParams } from "../../model-gateway/types.js";

const fixtures: Awaited<ReturnType<typeof createBasketFixture>>[] = [];
async function fixture(...args: Parameters<typeof createBasketFixture>) {
  const current = await createBasketFixture(...args);
  fixtures.push(current);
  return current;
}
afterEach(async () => {
  for (const current of fixtures.splice(0)) {
    await current.service.stop();
    await rm(current.root, { recursive: true, force: true });
  }
});

describe("personal Information Basket service", () => {
  test("indexes only vectors and locators, searches ready sources, and reads original windows", async () => {
    const f = await fixture();
    await configureBasket(f.service);
    const body = "PRIVATE_SOURCE_BODY_73 apple facts\n".repeat(150);
    const path = await f.source("apple.md", body);
    await f.service.addSources({ paths: [path, path] });
    const source = await waitForBasketSource(f.service);
    expect((await f.service.list()).sources).toHaveLength(1);
    expect(source.chunkCount).toBeGreaterThan(1);
    const stored = await readFile(join(f.config.paths.runtimeDir, "information-basket", "basket.json"), "utf8");
    expect(stored).not.toContain("PRIVATE_SOURCE_BODY_73");
    expect(stored).not.toContain('"text"');
    expect(f.embed).toHaveBeenCalled();
    const result = await f.service.search({ query: "apple", abortSignal: new AbortController().signal });
    expect(result.status).toBe("found");
    expect(result.sources[0]).toMatchObject({ sourceId: source.sourceId, expectedRevision: source.revision, score: 1 });
    expect(result.sources[0]).not.toHaveProperty("excerpt");
    const read = await f.service.readSource({ sourceId: source.sourceId, expectedRevision: source.revision, startChar: 13, maxChars: 200 });
    expect(read.text).toBe(body.slice(13, 213));
    expect(read).toMatchObject({ startChar: 13, endChar: 213, omittedBefore: 13, nextStartChar: 213 });
  });

  test("no profile and disabled basket do not invoke embeddings", async () => {
    const f = await fixture();
    await f.service.addSources({ paths: [await f.source("facts.txt", "apple facts")] });
    expect((await f.service.search({ query: "apple", abortSignal: new AbortController().signal })).reason)
      .toBe("basket_embedding_profile_required");
    expect(f.embed).not.toHaveBeenCalled();
    await f.service.updateSettings({ expectedRevision: 1, enabled: false, embeddingProfileId: "fixture" });
    expect((await f.service.search({ query: "apple", abortSignal: new AbortController().signal })).reason).toBe("basket_disabled");
    expect(f.embed).not.toHaveBeenCalled();
  });

  test("search neither waits for nor rebuilds an unfinished index, and stop cancels the worker", async () => {
    const embed = vi.fn(async (_input: ModelGatewayEmbeddingParams) => new Promise<ReturnType<typeof fixtureEmbedding>>(() => {}));
    const f = await fixture(embed);
    await configureBasket(f.service);
    await f.service.addSources({ paths: [await f.source("blocked.txt", "apple facts")] });
    await waitForBasketSource(f.service, "indexing");
    await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    await expect(f.service.search({ query: "apple", abortSignal: new AbortController().signal }))
      .resolves.toMatchObject({ status: "unavailable", reason: "basket_index_not_ready" });
    expect(embed).toHaveBeenCalledTimes(1);
    await f.service.stop();
    expect((await f.service.list()).sources[0]!.status).toBe("queued");
  });

  test("changed, replaced and symlinked originals are rejected rather than rebound", async () => {
    const f = await fixture();
    await configureBasket(f.service);
    const path = await f.source("bound.txt", "apple original");
    await f.service.addSources({ paths: [path] });
    let source = await waitForBasketSource(f.service);
    const target = { sourceId: source.sourceId, expectedRevision: source.revision };
    await writeFile(path, "apple changed");
    await expect(f.service.readSource(target)).rejects.toMatchObject({ code: "basket_source_stale" });
    await f.service.refreshSource(target);
    source = await waitForBasketSource(f.service);
    const replacement = await f.source("replacement.txt", "apple changed");
    await rename(replacement, path);
    await expect(f.service.readSource({ sourceId: source.sourceId, expectedRevision: source.revision }))
      .rejects.toMatchObject({ code: "basket_source_stale" });
    await f.service.refreshSource({ sourceId: source.sourceId, expectedRevision: source.revision });
    source = await waitForBasketSource(f.service);
    await rm(path);
    const foreign = await f.source("foreign.txt", "private foreign bytes");
    await symlink(foreign, path);
    await expect(f.service.readSource({ sourceId: source.sourceId, expectedRevision: source.revision })).rejects.toBeDefined();
  });

  test("removal invalidates late index publication and preserves original bytes", async () => {
    let finish!: (result: ReturnType<typeof fixtureEmbedding>) => void;
    const embed = vi.fn((input: ModelGatewayEmbeddingParams) => new Promise<ReturnType<typeof fixtureEmbedding>>(resolve => {
      finish = () => resolve(fixtureEmbedding(input));
    }));
    const f = await fixture(embed);
    await configureBasket(f.service);
    const path = await f.source("removed.txt", "original stays");
    await f.service.addSources({ paths: [path] });
    const source = await waitForBasketSource(f.service, "indexing");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await f.service.removeSource({ sourceId: source.sourceId, expectedRevision: source.revision });
    finish(fixtureEmbedding({ profileId: "fixture", texts: ["original"], abortSignal: new AbortController().signal }));
    await f.service.stop();
    expect((await f.service.list()).sources).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("original stays");
  });

  test("fingerprint mismatch cannot compare incompatible vectors or trigger rebuilding", async () => {
    const f = await fixture();
    await configureBasket(f.service);
    await f.service.addSources({ paths: [await f.source("facts.txt", "apple")] });
    await waitForBasketSource(f.service);
    const before = f.embed.mock.calls.length;
    f.embed.mockImplementation(async input => ({ ...fixtureEmbedding(input), modelFingerprint: "changed-model" }));
    expect(await f.service.search({ query: "apple", abortSignal: new AbortController().signal }))
      .toMatchObject({ status: "unavailable", reason: "basket_embedding_binding_changed" });
    expect(f.embed.mock.calls.length).toBe(before + 1);
    expect((await f.service.list()).sources[0]!.status).toBe("ready");
  });

  test("copied metadata cannot silently bind a path in another runtime namespace", async () => {
    const f = await fixture();
    await f.service.addSources({ paths: [await f.source("facts.txt", "apple")] });
    const other = createInformationBasketService({
      config: { ...f.config, runtimeId: "another-environment" }, models: { embed: f.embed },
    });
    await expect(other.list()).rejects.toMatchObject({ code: "basket_storage_host_mismatch" });
    await other.stop();
  });

  test("revision conflicts preserve the registered source and committed notifications omit bodies", async () => {
    const f = await fixture();
    const changed = vi.fn();
    f.service.subscribeChanges(changed);
    await f.service.addSources({ paths: [await f.source("facts.txt", "apple")] });
    const source = (await f.service.list()).sources[0]!;
    await expect(f.service.removeSource({ sourceId: source.sourceId, expectedRevision: source.revision + 1 }))
      .rejects.toMatchObject({ code: "basket_source_revision_conflict" });
    expect((await f.service.list()).sources).toHaveLength(1);
    expect(changed).toHaveBeenCalledWith({
      settingsChanged: false, invalidatedSourceIds: [], readySourcesAdded: false,
    });
  });

  test("shutdown aborts direct search work and only explicit startup reopens the service", async () => {
    const f = await fixture();
    await configureBasket(f.service);
    await f.service.addSources({ paths: [await f.source("facts.txt", "apple")] });
    await waitForBasketSource(f.service);
    const calls = f.embed.mock.calls.length;
    f.embed.mockImplementation(async () => new Promise(() => {}));
    const pending = f.service.search({ query: "apple", abortSignal: new AbortController().signal }).catch(error => error);
    await vi.waitFor(() => expect(f.embed).toHaveBeenCalledTimes(calls + 1));
    await f.service.stop();
    expect(await pending).toMatchObject({ code: "basket_service_stopped" });
    expect(f.embed.mock.calls.at(-1)![0].abortSignal.aborted).toBe(true);
    await expect(f.service.search({ query: "apple", abortSignal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "basket_service_stopped" });
    f.embed.mockImplementation(async input => fixtureEmbedding(input));
    await f.service.start();
    expect((await f.service.search({ query: "apple", abortSignal: new AbortController().signal })).status).toBe("found");
  });

  test("chunks preserve coverage and vector normalization rejects incompatible inputs", () => {
    const text = "Paragraph about a file.\n".repeat(600);
    const chunks = chunkBasketText(text);
    expect(chunks[0]!.startChar).toBe(0);
    expect(chunks.at(-1)!.endChar).toBe(text.length);
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.text).toBe(text.slice(chunk.startChar, chunk.endChar));
      if (index) expect(chunk.startChar).toBeLessThan(chunks[index - 1]!.endChar);
    }
    expect(normalizeBasketVector([3, 4])).toEqual([0.6, 0.8]);
    expect(() => normalizeBasketVector([0, 0])).toThrow();
    expect(() => normalizeBasketVector([1, Number.NaN])).toThrow();
    expect(() => normalizeBasketVector([1, 2], 3)).toThrow();
  });
});


test("folder registration remains atomic at the existing basket capacity", async () => {
  const f = await fixture();
  const paths = await Promise.all(Array.from({ length: BASKET_LIMITS.maxSources },
    (_, index) => f.source(`folder-${index}.txt`, "Registered source")));
  await expect(f.service.addSources({ paths: [...paths.slice(0, 60), join(f.files, "missing.txt")] }))
    .rejects.toBeDefined();
  expect((await f.service.list()).sources).toHaveLength(0);
  await f.service.addSources({ paths });
  const registered = (await f.service.list()).sources.map(source => source.sourceId);
  expect(registered).toHaveLength(BASKET_LIMITS.maxSources);
  await f.service.addSources({ paths });
  expect((await f.service.list()).sources.map(source => source.sourceId)).toEqual(registered);
  const overflow = await f.source("overflow.txt", "Outside basket capacity");
  await expect(f.service.addSources({ paths: [overflow] })).rejects.toMatchObject({ code: "basket_source_count_limit" });
  await expect(f.service.addSources({ paths: [...paths, overflow] })).rejects.toMatchObject({ code: "basket_source_batch_invalid" });
  expect((await f.service.list()).sources.map(source => source.sourceId)).toEqual(registered);
});
