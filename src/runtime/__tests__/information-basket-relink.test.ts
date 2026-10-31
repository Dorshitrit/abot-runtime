import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { ModelGatewayEmbeddingParams } from "../../model-gateway/types.js";
import { InformationBasketError } from "../information-basket/contracts.js";
import type { BasketSnapshot } from "../information-basket/index-records.js";
import { createBasketManagement } from "../information-basket/management.js";
import { readBasketSourceDocument } from "../information-basket/source-reader.js";
import { createBasketSourceReading } from "../information-basket/source-reading.js";
import { createBasketStateOwner } from "../information-basket/state-owner.js";
import { configureBasket, createBasketFixture, fixtureEmbedding, waitForBasketSource } from "./support/information-basket-fixture.js";

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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function readyFixture() {
  const f = await fixture();
  await configureBasket(f.service);
  const path = await f.source("original.txt", "apple original source");
  await f.service.addSources({ paths: [path] });
  const source = await waitForBasketSource(f.service);
  return { ...f, path, registered: source, target: { sourceId: source.sourceId, expectedRevision: source.revision } };
}

test("relink keeps the source ID, replaces metadata once, invalidates retrieval and preserves originals", async () => {
  const f = await readyFixture();
  const replacement = await f.source("replacement.md", "orange replacement source");
  const held = deferred<ReturnType<typeof fixtureEmbedding>>();
  let captured!: ModelGatewayEmbeddingParams;
  f.embed.mockImplementationOnce(input => { captured = input; return held.promise; });
  const changed = vi.fn();
  f.service.subscribeChanges(changed);
  const result = await f.service.relinkSource({ ...f.target, path: replacement });
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0]).toMatchObject({ sourceId: f.registered.sourceId, revision: f.registered.revision + 1,
    path: replacement, displayName: "replacement.md", sizeBytes: 25, chunkCount: 0, indexedAt: null, reason: null });
  expect(result.sources[0]!.status).not.toBe("ready");
  expect(changed).toHaveBeenCalledWith({ settingsChanged: false, invalidatedSourceIds: [f.registered.sourceId], readySourcesAdded: false });
  await expect(f.service.readSource(f.target)).rejects.toMatchObject({ code: "basket_source_revision_conflict" });
  await vi.waitFor(() => expect(captured).toBeDefined());
  held.resolve(fixtureEmbedding(captured));
  const ready = await waitForBasketSource(f.service);
  expect(ready.revision).toBe(f.registered.revision + 1);
  expect(await f.service.readSource({ sourceId: ready.sourceId, expectedRevision: ready.revision }))
    .toMatchObject({ path: replacement, displayName: "replacement.md", text: "orange replacement source" });
  expect(await readFile(f.path, "utf8")).toBe("apple original source");
  expect(await readFile(replacement, "utf8")).toBe("orange replacement source");
  const stored = await readFile(join(f.config.paths.runtimeDir, "information-basket", "basket.json"), "utf8");
  expect(stored).not.toContain("orange replacement source");
  expect(JSON.stringify(changed.mock.calls)).not.toContain(replacement);
});

test("invalid paths, revisions and another source's canonical path leave the registration untouched", async () => {
  const f = await readyFixture();
  const otherPath = await f.source("other.txt", "another source");
  await f.service.addSources({ paths: [otherPath] });
  await f.service.stop();
  const before = await f.service.list();
  const changed = vi.fn();
  f.service.subscribeChanges(changed);
  const rejected = [
    { path: join(f.files, "missing.txt"), expectedRevision: f.target.expectedRevision, code: "basket_source_not_found" },
    { path: "relative.txt", expectedRevision: f.target.expectedRevision, code: "basket_source_absolute_path_required" },
    { path: f.files, expectedRevision: f.target.expectedRevision, code: "basket_source_regular_file_required" },
    { path: await f.source("unsupported.doc", "content"), expectedRevision: f.target.expectedRevision, code: "basket_source_format_unsupported" },
    { path: otherPath, expectedRevision: f.target.expectedRevision, code: "basket_source_path_conflict" },
    { path: `${f.files}/./other.txt`, expectedRevision: f.target.expectedRevision, code: "basket_source_path_conflict" },
    { path: f.path, expectedRevision: f.target.expectedRevision + 1, code: "basket_source_revision_conflict" },
    { path: f.path, expectedRevision: 0, code: "basket_source_revision_invalid" },
  ];
  for (const { path, expectedRevision, code } of rejected) {
    await expect(f.service.relinkSource({ sourceId: f.registered.sourceId, expectedRevision, path })).rejects.toMatchObject({ code });
    expect(await f.service.list()).toEqual(before);
  }
  expect(changed).not.toHaveBeenCalled();
});

test("two relinks of one revision commit only one replacement", async () => {
  const f = await readyFixture();
  await f.service.stop();
  const paths = await Promise.all([f.source("a.txt", "first"), f.source("b.txt", "second")]);
  const results = await Promise.allSettled(paths.map(path => f.service.relinkSource({ ...f.target, path })));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const failed = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  expect(failed.reason).toMatchObject({ code: "basket_source_revision_conflict" });
  const source = (await f.service.list()).sources[0]!;
  expect(source).toMatchObject({ sourceId: f.registered.sourceId, revision: f.registered.revision + 1, status: "queued" });
  expect(paths).toContain(source.path);
});

test("two sources cannot atomically claim the same replacement path", async () => {
  const f = await fixture();
  await f.service.addSources({ paths: [await f.source("first.txt", "first"), await f.source("second.txt", "second")] });
  const before = (await f.service.list()).sources;
  const path = await f.source("shared.txt", "replacement");
  const results = await Promise.allSettled(before.map(source => f.service.relinkSource({
    sourceId: source.sourceId, expectedRevision: source.revision, path,
  })));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const failed = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  expect(failed.reason).toMatchObject({ code: "basket_source_path_conflict" });
  const after = (await f.service.list()).sources;
  expect(after.filter(source => source.path === path)).toHaveLength(1);
  const unchanged = after.find(source => source.path !== path)!;
  expect(unchanged).toEqual(before.find(source => source.sourceId === unchanged.sourceId));
});

test("relinking the same registered path is an explicit refresh, not a duplicate registration", async () => {
  const f = await readyFixture();
  await f.service.stop();
  const result = await f.service.relinkSource({ ...f.target, path: f.path });
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0]).toMatchObject({ sourceId: f.registered.sourceId, path: f.path,
    revision: f.registered.revision + 1, status: "queued", chunkCount: 0, indexedAt: null });
});

test("relink cancels an old indexing job and its late provider result cannot overwrite the replacement", async () => {
  const held = deferred<ReturnType<typeof fixtureEmbedding>>();
  let oldInput!: ModelGatewayEmbeddingParams;
  const embed = vi.fn(async (input: ModelGatewayEmbeddingParams) => fixtureEmbedding(input));
  embed.mockImplementationOnce(input => { oldInput = input; return held.promise; });
  const f = await fixture(embed);
  await configureBasket(f.service);
  await f.service.addSources({ paths: [await f.source("old.txt", "apple old index")] });
  const old = await waitForBasketSource(f.service, "indexing");
  await vi.waitFor(() => expect(oldInput).toBeDefined());
  await expect(f.service.relinkSource({ sourceId: old.sourceId, expectedRevision: old.revision,
    path: join(f.files, "missing.txt") })).rejects.toMatchObject({ code: "basket_source_not_found" });
  expect(oldInput.abortSignal.aborted).toBe(false);
  const path = await f.source("new.txt", "orange new index");
  await f.service.relinkSource({ sourceId: old.sourceId, expectedRevision: old.revision, path });
  expect(oldInput.abortSignal.aborted).toBe(true);
  const ready = await waitForBasketSource(f.service);
  held.resolve(fixtureEmbedding(oldInput));
  await setImmediate();
  expect((await f.service.list()).sources[0]).toEqual(ready);
  expect(await f.service.readSource({ sourceId: old.sourceId, expectedRevision: ready.revision }))
    .toMatchObject({ path, text: "orange new index" });
});

test.each([false, true])("an old in-flight read cannot return or invalidate a relinked source (reader fails=%s)", async fails => {
  const f = await readyFixture();
  await f.service.stop();
  let snapshot = JSON.parse(await readFile(join(f.config.paths.runtimeDir, "information-basket", "basket.json"), "utf8")) as BasketSnapshot;
  const state = createBasketStateOwner({ read: async () => snapshot,
    update: async change => { snapshot = change(snapshot); return snapshot; } });
  const original = await readBasketSourceDocument(f.path);
  const held = deferred<void>();
  const reader = vi.fn(async () => {
    await held.promise;
    if (fails) throw new InformationBasketError("basket_source_unavailable");
    return original;
  });
  const read = createBasketSourceReading(state, reader)(f.target).catch(error => error);
  await vi.waitFor(() => expect(reader).toHaveBeenCalledOnce());
  const management = createBasketManagement({ config: f.config, models: { embed: f.embed }, state,
    queue: { wake: vi.fn(), cancelSource: vi.fn() } });
  const path = await f.source("new.txt", "orange replacement");
  await management.relinkSource({ ...f.target, path });
  held.resolve();
  expect(await read).toMatchObject({ code: fails ? "basket_source_unavailable" : "basket_source_revision_conflict" });
  expect((await state.read()).sources[0]).toMatchObject({ sourceId: f.registered.sourceId, path,
    revision: f.registered.revision + 1, status: "queued", reason: null, index: null });
});
