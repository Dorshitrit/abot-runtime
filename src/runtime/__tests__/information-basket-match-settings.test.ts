import { rm } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { emptyBasketSnapshot } from "../information-basket/index-records.js";
import { parseBasketSnapshot } from "../information-basket/snapshot-validation.js";
import { createInformationBasketService } from "../information-basket/service.js";
import type { BasketSettingsChange } from "../information-basket/contracts.js";
import { configureBasket, createBasketFixture, fixtureEmbedding, waitForBasketSource } from "./support/information-basket-fixture.js";
import type { ModelGatewayEmbeddingParams } from "../../model-gateway/types.js";

const fixtures: Awaited<ReturnType<typeof createBasketFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.service.stop(); await rm(f.root, { recursive: true, force: true }); }
});

test("new and legacy stores default to balanced and reject invalid saved modes", () => {
  const snapshot = emptyBasketSnapshot("host");
  expect(snapshot.settings.matchMode).toBe("balanced");
  const { matchMode: _unused, ...settings } = snapshot.settings;
  expect(parseBasketSnapshot({ ...snapshot, settings }, "host").settings.matchMode).toBe("balanced");
  for (const matchMode of [null, "unknown", 0.6, "", false])
    expect(() => parseBasketSnapshot({ ...snapshot, settings: { ...settings, matchMode } }, "host"))
      .toThrow("basket_storage_invalid");
});

test("mode persists across restart, omitted settings preserve it and invalid writes have no effect", async () => {
  const f = await createBasketFixture(); fixtures.push(f);
  const view = await f.service.list();
  const changed = await f.service.updateSettings({ expectedRevision: view.settings.revision,
    enabled: true, embeddingProfileId: null, matchMode: "strict" });
  const preserved = await f.service.updateSettings({ expectedRevision: changed.settings.revision,
    enabled: true, embeddingProfileId: null, indexChatUploads: true });
  expect(preserved.settings.matchMode).toBe("strict");
  for (const matchMode of [null, "unknown", 0.6])
    await expect(f.service.updateSettings({ expectedRevision: preserved.settings.revision,
      enabled: true, embeddingProfileId: null, matchMode } as unknown as BasketSettingsChange))
      .rejects.toThrow("basket_settings_invalid");
  expect((await f.service.list()).settings).toEqual(preserved.settings);
  await f.service.stop();
  const reopened = createInformationBasketService({ config: f.config, models: { embed: f.embed } });
  try {
    await reopened.start();
    expect((await reopened.list()).settings).toEqual(preserved.settings);
  } finally { await reopened.stop(); }
});

test("changing mode invalidates discovery without cancelling indexing or replacing source revisions", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const embed = vi.fn(async (input: ModelGatewayEmbeddingParams) => { await pending; return fixtureEmbedding(input); });
  const f = await createBasketFixture(embed); fixtures.push(f);
  try {
    await configureBasket(f.service);
    await f.service.addSources({ paths: [await f.source("notes.txt", "apple")] });
    const indexing = await waitForBasketSource(f.service, "indexing");
    const changed = vi.fn(); const unsubscribe = f.service.subscribeChanges(changed);
    const view = await f.service.list();
    await f.service.updateSettings({ expectedRevision: view.settings.revision,
      enabled: true, embeddingProfileId: "fixture", matchMode: "flexible" });
    expect(changed).toHaveBeenLastCalledWith({ settingsChanged: true, invalidatedSourceIds: [], readySourcesAdded: false });
    expect((await f.service.list()).sources[0]).toEqual(indexing);
    finish();
    const ready = await waitForBasketSource(f.service);
    expect(ready.revision).toBe(indexing.revision);
    expect(embed).toHaveBeenCalledOnce();
    const next = await f.service.list();
    await f.service.updateSettings({ expectedRevision: next.settings.revision,
      enabled: true, embeddingProfileId: "fixture", matchMode: "strict" });
    expect((await f.service.list()).sources[0]).toEqual(ready);
    expect(embed).toHaveBeenCalledOnce();
    unsubscribe();
  } finally { finish(); }
});
