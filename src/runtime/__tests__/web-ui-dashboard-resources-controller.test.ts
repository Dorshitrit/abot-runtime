import { describe, expect, test, vi } from "vitest";
import type { BasketView } from "../information-basket/contracts.js";
import { attentionSource, basketView, deferred, replacementPath, resourcesFixture } from "./support/dashboard-resources-fixture.js";

const missing = { ...attentionSource, status: "missing" as const, reason: "basket_source_not_found" };

describe("Home Resources metadata and action ownership", () => {
  test.each(["inactive", "unsupported"])("does not read or mutate when %s", async (gate) => {
    const f = resourcesFixture({ interactive: gate !== "inactive", supported: gate !== "unsupported" });
    await f.controller.refresh();
    expect(await f.controller.reindex(attentionSource.sourceId)).toBe(false);
    expect(await f.controller.relink(attentionSource.sourceId)).toBe(false);
    expect(f.client.listInformationBasket).not.toHaveBeenCalled();
    expect(f.client.reindexInformationBasketSource).not.toHaveBeenCalled();
    expect(f.client.relinkInformationBasketSource).not.toHaveBeenCalled();
    expect(f.client.browseInformationBasket).not.toHaveBeenCalled();
    expect(f.attention().issues).toEqual([]);
  });

  test("retains last known problems on a failed read and disables actions until a successful refresh", async () => {
    const f = resourcesFixture();
    await f.controller.refresh();
    f.client.listInformationBasket.mockRejectedValueOnce(new Error("private /path/internal"));
    await f.controller.refresh();
    expect(f.attention().issues).toMatchObject([{ sourceId: attentionSource.sourceId, revision: 3 }]);
    expect(f.attention().error).toContain("out of date");
    expect(JSON.stringify(f.attention())).not.toContain("private /path/internal");
    expect(await f.controller.reindex(attentionSource.sourceId)).toBe(false);
    expect(f.client.reindexInformationBasketSource).not.toHaveBeenCalled();
    await f.controller.refresh();
    expect(f.attention().error).toBe("");
    expect(await f.controller.reindex(attentionSource.sourceId, 3)).toBe(true);
  });

  test("coalesces repeated refreshes into one follow-up metadata read", async () => {
    const first = deferred<BasketView>();
    const f = resourcesFixture();
    f.client.listInformationBasket.mockReturnValueOnce(first.promise);
    const pending = f.controller.refresh();
    for (let index = 0; index < 8; index++) void f.controller.refresh();
    expect(f.client.listInformationBasket).toHaveBeenCalledExactlyOnceWith("dev");
    first.resolve(basketView());
    await pending;
    await vi.waitFor(() => expect(f.client.listInformationBasket).toHaveBeenCalledTimes(2));
    expect(f.attention().issues).toHaveLength(1);
    expect(f.client.reindexInformationBasketSource).not.toHaveBeenCalled();
  });

  test("an obsolete read cannot overwrite the current environment or invalidate its pending read", async () => {
    const old = deferred<BasketView>();
    const current = deferred<BasketView>();
    const f = resourcesFixture();
    f.client.listInformationBasket.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const oldRead = f.controller.refresh();
    f.setEnvironment("prod");
    f.controller.invalidate();
    const currentRead = f.controller.refresh();
    old.resolve(basketView());
    await oldRead;
    expect(f.attention()).toMatchObject({ issues: [], loading: true, error: "" });
    current.resolve(basketView([{ ...missing, sourceId: "prod-source" }]));
    await currentRead;
    expect(f.attention().issues).toMatchObject([{ sourceId: "prod-source" }]);
    expect(f.client.listInformationBasket.mock.calls).toEqual([["dev"], ["prod"]]);
  });

  test("reindex sends the observed identity once and rejects a stale rendered revision", async () => {
    const pending = deferred<BasketView>();
    const f = resourcesFixture();
    await f.controller.refresh();
    expect(await f.controller.reindex(attentionSource.sourceId, 2)).toBe(false);
    expect(await f.controller.reindex("unknown", 3)).toBe(false);
    f.client.reindexInformationBasketSource.mockReturnValueOnce(pending.promise);
    const action = f.controller.reindex(attentionSource.sourceId, 3);
    expect(await f.controller.reindex(attentionSource.sourceId, 3)).toBe(false);
    expect(f.attention().mutation).toBe("reindex");
    expect(f.client.reindexInformationBasketSource).toHaveBeenCalledExactlyOnceWith("source-a", 3, "dev");
    pending.resolve(basketView([{ ...attentionSource, revision: 4, status: "queued" }]));
    expect(await action).toBe(true);
    expect(f.attention()).toMatchObject({ issues: [], mutation: "", message: "Source queued for indexing." });
    expect(f.notify).toHaveBeenCalledExactlyOnceWith("Source queued for indexing.");
  });

  test("unavailable embedding configuration blocks a previously offered reindex without changing settings", async () => {
    const f = resourcesFixture();
    await f.controller.refresh();
    f.client.listInformationBasket.mockResolvedValue({
      ...basketView(), settings: { revision: 3, enabled: false, embeddingProfileId: "local-embed" },
    });
    await f.controller.refresh();
    expect(f.attention().issues[0]).toMatchObject({ sourceId: "source-a", action: "settings" });
    expect(await f.controller.reindex("source-a", 3)).toBe(false);
    expect(f.client.reindexInformationBasketSource).not.toHaveBeenCalled();
  });

  test("a read started before a mutation cannot restore the obsolete source problem", async () => {
    const old = deferred<BasketView>();
    const f = resourcesFixture();
    await f.controller.refresh();
    f.client.listInformationBasket.mockReturnValueOnce(old.promise);
    const read = f.controller.refresh();
    await f.controller.reindex(attentionSource.sourceId, 3);
    old.resolve(basketView());
    await read;
    expect(f.attention()).toMatchObject({ issues: [], mutation: "", loading: false });
  });

  test("refreshes during mutation reconcile once without dispatching another action", async () => {
    const pending = deferred<BasketView>();
    const f = resourcesFixture();
    await f.controller.refresh();
    f.client.reindexInformationBasketSource.mockReturnValueOnce(pending.promise);
    f.client.listInformationBasket.mockResolvedValue(basketView([]));
    const action = f.controller.reindex(attentionSource.sourceId);
    for (let index = 0; index < 6; index++) await f.controller.refresh();
    expect(f.client.listInformationBasket).toHaveBeenCalledTimes(1);
    pending.resolve(basketView([]));
    await action;
    await vi.waitFor(() => expect(f.client.listInformationBasket).toHaveBeenCalledTimes(2));
    expect(f.client.reindexInformationBasketSource).toHaveBeenCalledOnce();
  });

  test("an old mutation cannot publish source metadata, errors or feedback after invalidation", async () => {
    const pending = deferred<BasketView>();
    const f = resourcesFixture();
    await f.controller.refresh();
    f.client.reindexInformationBasketSource.mockReturnValueOnce(pending.promise);
    const action = f.controller.reindex(attentionSource.sourceId);
    f.setEnvironment("prod");
    f.controller.invalidate();
    f.client.listInformationBasket.mockResolvedValue(basketView([]));
    await f.controller.refresh();
    pending.reject(new Error("basket_source_revision_conflict"));
    expect(await action).toBe(false);
    expect(f.attention()).toMatchObject({ issues: [], error: "", mutationError: "", mutation: "", message: "" });
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.client.listInformationBasket).toHaveBeenCalledTimes(2);
  });

  test.each(["basket_source_not_found", "basket_source_revision_conflict"])(
    "clears an obsolete %s action error after metadata confirms no remaining problems", async code => {
      const f = resourcesFixture();
      await f.controller.refresh();
      f.client.reindexInformationBasketSource.mockRejectedValueOnce(new Error(code));
      f.client.listInformationBasket.mockResolvedValueOnce(basketView([]));
      expect(await f.controller.reindex(attentionSource.sourceId, 3)).toBe(false);
      await vi.waitFor(() => expect(f.attention()).toMatchObject({ issues: [], mutationError: "", error: "", loading: false }));
      expect(f.client.listInformationBasket).toHaveBeenCalledTimes(2);
      expect(f.client.reindexInformationBasketSource).toHaveBeenCalledExactlyOnceWith("source-a", 3, "dev");
      expect(f.notify).not.toHaveBeenCalled();
    },
  );

  test("relink opens the existing picker and mutates only after one explicit file selection", async () => {
    const f = resourcesFixture({ view: basketView([missing]) });
    await f.controller.refresh();
    expect(await f.controller.reindex(missing.sourceId)).toBe(false);
    await f.controller.relink(missing.sourceId, 3);
    expect(f.attention().picker).toMatchObject({ open: true, linkId: "source-a", linkName: missing.displayName });
    expect(f.client.relinkInformationBasketSource).not.toHaveBeenCalled();
    f.controller.picker.select(replacementPath);
    expect(await f.controller.picker.submit()).toBe(true);
    expect(f.client.relinkInformationBasketSource).toHaveBeenCalledExactlyOnceWith("source-a", 3, replacementPath, "dev");
    expect(f.attention()).toMatchObject({ issues: [], picker: { open: false } });
  });

  test("a relink selection cannot migrate to a newer source revision while the picker is open", async () => {
    const f = resourcesFixture({ view: basketView([missing]) });
    await f.controller.refresh();
    await f.controller.relink(missing.sourceId, 3);
    f.controller.picker.select(replacementPath);
    f.client.listInformationBasket.mockResolvedValue(basketView([{ ...missing, revision: 4 }]));
    await f.controller.refresh();
    expect(await f.controller.picker.submit()).toBe(false);
    expect(f.client.relinkInformationBasketSource).not.toHaveBeenCalled();
    expect(f.attention().picker).toMatchObject({ open: true, error: expect.stringContaining("changed while the picker was open") });
  });

  test.each([
    ["basket_source_revision_conflict", "This source changed"],
    ["basket_source_path_conflict", "already linked"],
  ])("reports %s and reconciles metadata without retrying the relink", async (code, message) => {
    const f = resourcesFixture({ view: basketView([missing]) });
    await f.controller.refresh();
    await f.controller.relink(missing.sourceId);
    f.controller.picker.select(replacementPath);
    f.client.relinkInformationBasketSource.mockRejectedValueOnce(new Error(code));
    f.client.listInformationBasket.mockResolvedValueOnce(basketView([]));
    expect(await f.controller.picker.submit()).toBe(false);
    await vi.waitFor(() => expect(f.client.listInformationBasket).toHaveBeenCalledTimes(2));
    expect(f.client.relinkInformationBasketSource).toHaveBeenCalledOnce();
    expect(f.attention().picker).toMatchObject({ open: true, error: expect.stringContaining(message) });
    expect(f.attention().mutationError).toContain(message);
  });

  test("closing or invalidating the picker discards a late directory read and prevents submission", async () => {
    const f = resourcesFixture({ view: basketView([missing]) });
    await f.controller.refresh();
    const pending = deferred<Awaited<ReturnType<typeof f.client.browseInformationBasket>>>();
    f.client.browseInformationBasket.mockReturnValueOnce(pending.promise);
    const opening = f.controller.relink(missing.sourceId);
    f.controller.invalidate();
    pending.resolve({ directory: "/documents", parent: "/", roots: [], entries: [], nextCursor: null, hostPlatform: "linux" });
    await opening;
    expect(f.attention().picker).toMatchObject({ open: false, page: null, selectedPaths: [] });
    expect(await f.controller.picker.submit([replacementPath])).toBe(false);
    expect(f.client.relinkInformationBasketSource).not.toHaveBeenCalled();
  });
});
