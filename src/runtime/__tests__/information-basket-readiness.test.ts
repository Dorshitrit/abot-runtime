import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { InformationBasketService } from "../information-basket/contracts.js";
import type { BasketSnapshot, StoredBasketSource } from "../information-basket/index-records.js";
import { basketProfileSignature } from "../information-basket/profile-binding.js";
import { isBasketRetrievalReady } from "../information-basket/readiness.js";
import { createInformationBasketService } from "../information-basket/service.js";
import { configureBasket, createBasketFixture, waitForBasketSource } from "./support/information-basket-fixture.js";

const fixtures: Awaited<ReturnType<typeof createBasketFixture>>[] = [];
const extraServices: InformationBasketService[] = [];
async function fixture() {
  const f = await createBasketFixture();
  fixtures.push(f);
  return f;
}
async function indexedFixture() {
  const f = await fixture();
  await configureBasket(f.service);
  await f.service.addSources({ paths: [await f.source("ready.txt", "apple facts")] });
  const source = await waitForBasketSource(f.service);
  return { ...f, target: { sourceId: source.sourceId, expectedRevision: source.revision } };
}
afterEach(async () => {
  for (const service of extraServices.splice(0)) await service.stop();
  for (const f of fixtures.splice(0)) {
    await f.service.stop();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("readiness requires local settings, gateway and a compatible committed ready index", async () => {
  const f = await fixture();
  const source: StoredBasketSource = {
    sourceId: "basket-9b33376e-e415-44c7-9d1b-fd10f6900407", displayName: "Ready",
    path: join(f.files, "ready.txt"), revision: 1, status: "ready", sizeBytes: 5,
    chunkCount: 1, indexedAt: "2026-10-25T00:00:00Z", reason: null,
    index: {
      contentHash: "a".repeat(64), fileIdentity: "identity", chunkingVersion: 1,
      totalCharacters: 5, profileSignature: basketProfileSignature(f.config, "fixture"),
      modelFingerprint: "fixture-v1", dimensions: 2,
      chunks: [{ chunkId: "chunk-0", startChar: 0, endChar: 5, vector: [1, 0] }],
    },
  };
  const snapshot: BasketSnapshot = {
    schemaVersion: 1, hostNamespace: "fixture",
    settings: { matchMode: "balanced" as const, indexChatUploads: false, enabled: true, revision: 1, embeddingProfileId: "fixture" }, sources: [source],
  };
  const input = { snapshot, config: f.config, models: { embed: f.embed }, started: true };
  const sources = (value: readonly StoredBasketSource[]) => ({ ...input, snapshot: { ...snapshot, sources: value } });
  expect(isBasketRetrievalReady(input)).toBe(true);
  expect(isBasketRetrievalReady({ ...input, snapshot: undefined })).toBe(false);
  expect(isBasketRetrievalReady({ ...input, started: false })).toBe(false);
  expect(isBasketRetrievalReady({ ...input, models: {} })).toBe(false);
  expect(isBasketRetrievalReady({ ...input, snapshot: { ...snapshot,
    settings: { ...snapshot.settings, enabled: false } } })).toBe(false);
  for (const embeddingProfileId of [null, "missing"]) {
    expect(isBasketRetrievalReady({ ...input, snapshot: { ...snapshot,
      settings: { ...snapshot.settings, embeddingProfileId } } })).toBe(false);
  }
  expect(isBasketRetrievalReady({ ...input, config: {
    ...f.config, models: { ...f.config.models, providers: {} },
  } })).toBe(false);
  expect(isBasketRetrievalReady(sources([]))).toBe(false);
  for (const status of ["queued", "indexing", "stale", "missing", "failed", "unsupported"] as const)
    expect(isBasketRetrievalReady(sources([{ ...source, status }]))).toBe(false);
  expect(isBasketRetrievalReady(sources([{ ...source, index: null }]))).toBe(false);
  expect(isBasketRetrievalReady(sources([{ ...source, index: { ...source.index!, chunks: [] } }]))).toBe(false);
  expect(isBasketRetrievalReady(sources([{ ...source, index: { ...source.index!, profileSignature: "old" } }]))).toBe(false);
  expect(isBasketRetrievalReady(sources([{ ...source, status: "failed" }, source]))).toBe(true);
  expect(f.embed).not.toHaveBeenCalled();
});

test("readiness is synchronous, query independent, and follows committed disable and removal", async () => {
  const f = await indexedFixture();
  f.embed.mockClear();
  for (let i = 0; i < 5; i++) expect(f.service.isReady()).toBe(true);
  expect(f.embed).not.toHaveBeenCalled();
  expect((await f.service.search({ query: "orange", abortSignal: new AbortController().signal })).status).toBe("empty");
  expect(f.service.isReady()).toBe(true);
  const view = await f.service.list();
  await f.service.updateSettings({ expectedRevision: view.settings.revision, enabled: false, embeddingProfileId: "fixture" });
  expect(f.service.isReady()).toBe(false);
  await configureBasket(f.service);
  expect(f.service.isReady()).toBe(true);
  await f.service.removeSource(f.target);
  expect(f.service.isReady()).toBe(false);
});

test("loading persisted readiness needs successful startup and stop fences late startup", async () => {
  const f = await indexedFixture();
  await f.service.stop();
  const service = createInformationBasketService({ config: f.config, models: { embed: f.embed } });
  extraServices.push(service);
  f.embed.mockClear();
  expect(service.isReady()).toBe(false);
  await service.list();
  expect(service.isReady()).toBe(false);
  const starting = service.start();
  expect(service.start()).toBe(starting);
  const stopping = service.stop();
  expect(service.isReady()).toBe(false);
  await Promise.all([starting, stopping]);
  expect(service.isReady()).toBe(false);
  await service.start();
  expect(service.isReady()).toBe(true);
  const stopped = service.stop();
  expect(service.isReady()).toBe(false);
  await stopped;
  expect(f.embed).not.toHaveBeenCalled();
});

test("missing gateway and failed stored-state startup stay unavailable", async () => {
  const f = await indexedFixture();
  await f.service.stop();
  const missingGateway = createInformationBasketService({ config: f.config, models: {} });
  extraServices.push(missingGateway);
  await missingGateway.start();
  expect(missingGateway.isReady()).toBe(false);
  await missingGateway.stop();
  const file = join(f.config.paths.runtimeDir, "information-basket", "basket.json");
  const stored = await readFile(file, "utf8");
  await writeFile(file, "{ broken");
  const failed = createInformationBasketService({ config: f.config, models: { embed: f.embed } });
  extraServices.push(failed);
  expect(failed.isReady()).toBe(false);
  await expect(failed.start()).rejects.toMatchObject({ code: "basket_storage_unavailable" });
  expect(failed.isReady()).toBe(false);
  await writeFile(file, stored);
  await failed.start();
  expect(failed.isReady()).toBe(true);
});

test("profile replacement and unfinished indexing do not expose a ready capability", async () => {
  const f = await indexedFixture();
  f.embed.mockImplementation(async () => new Promise(() => {}));
  await configureBasket(f.service, "alternate");
  expect(f.service.isReady()).toBe(false);
  await waitForBasketSource(f.service, "indexing");
  expect(f.service.isReady()).toBe(false);
});
