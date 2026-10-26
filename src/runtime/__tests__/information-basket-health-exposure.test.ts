import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createInformationBasketToolModule } from "../capabilities/information-basket/tool-module.js";
import * as sourceReader from "../information-basket/source-reader.js";
import { configureBasket, createBasketFixture, waitForBasketSource } from "./support/information-basket-fixture.js";

const fixtures: Awaited<ReturnType<typeof createBasketFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.service.stop();
    await rm(f.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

test.each(["search", "list"] as const)("%s rejects a deleted/restored original before any content read", async action => {
  const reader = vi.spyOn(sourceReader, "readBasketSourceDocument");
  const f = await createBasketFixture();
  fixtures.push(f);
  await configureBasket(f.service);
  const body = "apple reference";
  const path = await f.source("restored.txt", body);
  await f.service.addSources({ paths: [path] });
  const ready = await waitForBasketSource(f.service);
  const target = { sourceId: ready.sourceId, expectedRevision: ready.revision };
  reader.mockClear();
  f.embed.mockClear();
  await rm(path);
  await writeFile(path, body);
  if (action === "search") {
    expect(await f.service.search({ query: "apple", abortSignal: new AbortController().signal }))
      .toMatchObject({ status: "empty", sources: [] });
  } else {
    const tool = createInformationBasketToolModule(f.service);
    const result = await tool.implementation({ action: "list_information_sources" });
    expect(JSON.parse(result.output!)).toMatchObject({ sources: [], omittedCount: 0, nextCursor: null });
  }
  expect(reader).not.toHaveBeenCalled();
  expect(f.embed).toHaveBeenCalledTimes(action === "search" ? 1 : 0);
  expect(f.service.isReady()).toBe(false);
  expect((await f.service.list()).sources[0]).toMatchObject({ status: "stale", reason: "basket_source_changed" });
  const disk = JSON.parse(await readFile(join(f.config.paths.runtimeDir, "information-basket", "basket.json"), "utf8"));
  expect(disk.sources[0]).toMatchObject({ index: null, chunkCount: 0, status: "stale" });
  expect(JSON.stringify(disk)).not.toContain(body);

  await f.service.refreshSource(target);
  const refreshed = await waitForBasketSource(f.service);
  expect(refreshed.revision).toBe(ready.revision + 1);
  expect((await f.service.search({ query: "apple", abortSignal: new AbortController().signal })).sources)
    .toMatchObject([{ sourceId: ready.sourceId, expectedRevision: refreshed.revision }]);
});

test("search omits missing and changed files while preserving a healthy source and emits one invalidation", async () => {
  const f = await createBasketFixture();
  fixtures.push(f);
  await configureBasket(f.service);
  const paths = await Promise.all(["missing.txt", "changed.txt", "healthy.txt"].map(name => f.source(name, "apple facts")));
  await f.service.addSources({ paths });
  await vi.waitFor(async () => expect((await f.service.list()).sources.every(source => source.status === "ready")).toBe(true));
  const changed = vi.fn();
  const unsubscribe = f.service.subscribeChanges(changed);
  try {
    await rm(paths[0]!);
    await writeFile(paths[1]!, "different apple content");
    const found = await f.service.search({ query: "apple", abortSignal: new AbortController().signal });
    expect(found.sources.map(source => source.displayName)).toEqual(["healthy.txt"]);
    expect(found.omittedCount).toBe(0);
    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.calls[0]![0].invalidatedSourceIds).toHaveLength(2);
    expect((await f.service.list()).sources.map(source => source.status)).toEqual(["missing", "stale", "ready"]);
  } finally { unsubscribe(); }
});
