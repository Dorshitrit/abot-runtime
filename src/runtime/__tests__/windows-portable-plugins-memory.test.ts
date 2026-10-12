import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import createMemoryPlugin from "../../../plugins/memory/source/index.js";
import type { RuntimePluginEntrypointFactory } from "../../plugin-contract/entrypoint.js";
import { loadBundledPluginEntrypoint } from "./public-plugin-test-support.js";
import { createPortablePluginFixture, removePortablePluginFixtures } from "./windows-portable-plugins-fixture.js";

const bundledFactory = loadBundledPluginEntrypoint<
  Parameters<RuntimePluginEntrypointFactory>[0],
  ReturnType<RuntimePluginEntrypointFactory>
>("memory");

const factories = [
  { name: "source", create: createMemoryPlugin },
  { name: "bundle", create: bundledFactory },
];

afterEach(removePortablePluginFixtures);

describe.each(factories)("portable memory $name", ({ create }) => {
  test("adds, reads, searches, deletes and reopens persisted memory", async () => {
    const context = await createPortablePluginFixture("memory");
    const plugin = create(context);
    const added = await plugin.handlers.memory_add!({ content: "Portable memory preference: use UTF-8." });
    expect(added).toMatchObject({ ok: true, data: { id: "mem-0001" } });
    const reopened = create(context);
    expect(await reopened.handlers.memory_get!({})).toMatchObject({
      ok: true,
      data: { itemCount: 1, returnedItemCount: 1 },
    });
    const found = await reopened.handlers.memory_search!({ query: "UTF-8" });
    expect(found).toMatchObject({ ok: true, data: { itemCount: 1 } });
    expect(found.output).toContain("Portable memory preference");
    expect(await reopened.handlers.memory_delete!({ id: "mem-0001" })).toMatchObject({
      ok: true,
      data: { deletedCount: 1 },
    });
    expect(await create(context).handlers.memory_get!({})).toMatchObject({
      ok: true,
      data: { itemCount: 0 },
    });
    expect(await create(context).handlers.memory_add!({ content: "Sequence survives reopening." })).toMatchObject({
      ok: true,
      data: { id: "mem-0002" },
    });
    expect(await readdir(context.stateDir)).toEqual(["memory.json"]);
  });

  test("independent instances serialize concurrent writes without lost entries", async () => {
    const context = await createPortablePluginFixture("memory");
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      create(context).handlers.memory_add!({ content: `Concurrent memory ${index}` }),
    ));
    expect(results.filter((result) => !result.ok)).toEqual([]);
    const saved = JSON.parse(await readFile(join(context.stateDir, "memory.json"), "utf8")) as {
      entries: { id: string; content: string }[];
      nextSequence: number;
    };
    expect(saved.entries).toHaveLength(8);
    expect(new Set(saved.entries.map(({ id }) => id)).size).toBe(8);
    expect(new Set(saved.entries.map(({ content }) => content)).size).toBe(8);
    expect(saved.nextSequence).toBe(9);
    expect(await readdir(context.stateDir)).toEqual(["memory.json"]);
    // Native lock contention may wait 10s; finish assertions before fixture cleanup.
  }, process.platform === "win32" ? 20_000 : 5_000);
});
