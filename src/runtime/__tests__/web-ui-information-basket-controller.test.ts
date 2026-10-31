import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createInformationBasketController } from "../../web-ui/app/controllers/information-basket-controller.js";
// @ts-expect-error Browser-only module.
import { createInformationBasketRequests } from "../../web-ui/app/services/runtime-web-client/information-basket.js";
import type { BasketView } from "../information-basket/contracts.js";

const source = { sourceId: "source-a", displayName: "Notes.md", path: "/documents/Notes.md", revision: 3,
  status: "ready" as const, sizeBytes: 100, chunkCount: 2, indexedAt: "2026-10-25T10:00:00Z", reason: null };
const view: BasketView = { settings: { matchMode: "balanced" as const, indexChatUploads: false, revision: 2, enabled: true, embeddingProfileId: "local-embed" }, sources: [source],
  embeddingProfiles: [{ id: "local-embed", label: "Local", provider: "ollama", model: "embedding" }],
  supportedExtensions: [".md"], limits: { maxSources: 100, maxSourceBytes: 10000, maxReadCharacters: 1000 } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }
function fixture(overrides = {}) {
  let environment = "dev";
  let visible = true;
  const client = {
    supportsInformationBasket: () => true,
    listInformationBasket: vi.fn(async () => view),
    registerInformationBasketSources: vi.fn(async () => view),
    saveInformationBasketSettings: vi.fn(async () => view),
    browseInformationBasket: vi.fn(async () => ({ directory: "/documents", parent: "/", roots: [{ label: "Documents", path: "/documents" }],
      entries: [{ name: "Notes.md", path: source.path, kind: "file", supported: true }], nextCursor: null, hostPlatform: "linux" })),
    reindexInformationBasketSource: vi.fn(async () => ({ ...view, sources: [{ ...source, status: "queued" }] })),
    removeInformationBasketSource: vi.fn(async () => ({ ...view, sources: [] })), ...overrides,
  };
  const confirmRemove = vi.fn(async () => true);
  const controller = createInformationBasketController({ client, getEnvironmentId: () => environment,
    isVisible: () => visible, render: vi.fn(), confirmRemove });
  return { client, controller, confirmRemove, setVisible(value: boolean) { visible = value; },
    setEnvironment(value: string) { environment = value; return controller.environmentChanged(); } };
}
async function activate(f: ReturnType<typeof fixture>) {
  f.controller.setActive(true);
  await vi.waitFor(() => expect(f.controller.snapshot().loading).toBe(false));
}

test("transport sends only paths and expected revisions, scopes calls and refuses bridge", async () => {
  let backend = "runtime";
  const requestApi = vi.fn(async () => ({ ok: true }));
  const client = createInformationBasketRequests({ requestApi, getEnvironmentId: () => "dev one", getConfig: () => ({ backend }) });
  await client.registerInformationBasketSources([source.path]);
  expect(requestApi).toHaveBeenLastCalledWith("/runtime/information-basket?environment=dev+one", { method: "POST", body: JSON.stringify({ paths: [source.path] }) });
  await client.removeInformationBasketSource("id/with slash", 3, "prod");
  expect(requestApi).toHaveBeenLastCalledWith("/runtime/information-basket/id%2Fwith%20slash?environment=prod", { method: "DELETE", body: '{"expectedRevision":3}' });
  await client.browseInformationBasket("/documents", "dev", "next page");
  expect(requestApi).toHaveBeenLastCalledWith("/runtime/information-basket/browse?environment=dev&path=%2Fdocuments&cursor=next+page", undefined);
  backend = "bridge";
  expect(() => client.listInformationBasket()).toThrow("local Runtime");
});

test("only explicit Runtime paths are registered through the file picker", async () => {
  const f = fixture(); await activate(f);
  expect(f.controller.receiveDrop).toBeUndefined();
  expect(f.client.registerInformationBasketSources).not.toHaveBeenCalled();
  await f.controller.picker.open();
  f.controller.picker.select(source.path);
  await f.controller.picker.submit();
  expect(f.client.registerInformationBasketSources).toHaveBeenCalledExactlyOnceWith([source.path], "dev");
  expect(f.controller.snapshot().picker.open).toBe(false);
});

test("stale reads and mutations cannot replace the next environment or dispatch further bulk calls", async () => {
  const oldRead = deferred<BasketView>();
  const f = fixture({ listInformationBasket: vi.fn().mockReturnValueOnce(oldRead.promise).mockResolvedValue({ ...view, sources: [] }) });
  f.controller.setActive(true);
  await f.setEnvironment("prod");
  oldRead.resolve(view);
  await Promise.resolve(); await Promise.resolve();
  expect(f.controller.snapshot().sources).toEqual([]);
  const first = deferred<BasketView>();
  f.client.listInformationBasket.mockResolvedValue({ ...view, sources: [source, { ...source, sourceId: "source-b" }] });
  await f.controller.refresh();
  f.client.removeInformationBasketSource.mockReturnValueOnce(first.promise as never);
  const removal = f.controller.remove(["source-a", "source-b"]);
  await vi.waitFor(() => expect(f.client.removeInformationBasketSource).toHaveBeenCalledTimes(1));
  await f.setEnvironment("next");
  first.resolve({ ...view, sources: [] }); await removal;
  expect(f.client.removeInformationBasketSource).toHaveBeenCalledTimes(1);
  expect(f.controller.snapshot().sources).toHaveLength(2);
});

test("remove confirms the source registration only and uses its observed revision", async () => {
  const f = fixture(); await activate(f);
  f.confirmRemove.mockResolvedValueOnce(false);
  expect(await f.controller.remove([source.sourceId])).toBe(false);
  expect(f.client.removeInformationBasketSource).not.toHaveBeenCalled();
  expect(await f.controller.remove([source.sourceId])).toBe(true);
  expect(f.client.removeInformationBasketSource).toHaveBeenCalledExactlyOnceWith(source.sourceId, source.revision, "dev");
  expect(f.controller.snapshot().sources).toEqual([]);
  expect(f.controller.snapshot().message).toContain("Original files were not deleted");
});

test("index invalidations coalesce while a read is pending and hidden views reconcile on return", async () => {
  const f = fixture(); await activate(f);
  const pending = deferred<BasketView>(); f.client.listInformationBasket.mockReturnValueOnce(pending.promise);
  const read = f.controller.refresh();
  f.controller.handleRealtime({ type: "workspace_changed", environment: "other", resources: ["information-basket"] });
  f.controller.handleRealtime({ type: "workspace_changed", environment: "dev", resources: ["information-basket"] });
  f.controller.handleRealtime({ type: "workspace_changed", environment: "dev", resources: ["information-basket"] });
  expect(f.client.listInformationBasket).toHaveBeenCalledTimes(2);
  pending.resolve(view); await read;
  await vi.waitFor(() => expect(f.client.listInformationBasket).toHaveBeenCalledTimes(3));
  f.setVisible(false); await f.controller.visibilityChanged();
  expect(f.client.listInformationBasket).toHaveBeenCalledTimes(3);
  f.setVisible(true); await f.controller.visibilityChanged();
  expect(f.client.listInformationBasket).toHaveBeenCalledTimes(4);
});

test("profile changes save explicitly with revision and environment changes clear unsaved settings", async () => {
  const f = fixture(); await activate(f);
  f.controller.changeSettings("embeddingProfileId", "another");
  expect(f.client.saveInformationBasketSettings).not.toHaveBeenCalled();
  await f.controller.saveSettings();
  expect(f.client.saveInformationBasketSettings).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 2, enabled: true, matchMode: "balanced", indexChatUploads: false, embeddingProfileId: "another" }, "dev");
  f.controller.changeSettings("enabled", false);
  await f.setEnvironment("prod");
  expect(f.controller.snapshot().settingsDraft).toEqual(view.settings);
  expect(f.controller.snapshot().settingsDirty).toBe(false);
});

test("picker pagination keeps real paths and late folder responses cannot reopen a closed picker", async () => {
  const f = fixture(); await activate(f);
  await f.controller.picker.open();
  f.controller.picker.select(source.path);
  expect(f.controller.snapshot().picker.selectedPaths).toEqual([source.path]);
  const pending = deferred<unknown>(); f.client.browseInformationBasket.mockReturnValueOnce(pending.promise as never);
  const read = f.controller.picker.browse("/other");
  f.controller.picker.close();
  pending.resolve({ directory: "/other", entries: [], roots: [], parent: null, nextCursor: null }); await read;
  expect(f.controller.snapshot().picker.open).toBe(false);
  expect(f.controller.snapshot().picker.page).toBe(null);
});

test("failed bulk mutations reconcile committed records while retaining the error", async () => {
  const f = fixture(); await activate(f);
  f.client.removeInformationBasketSource.mockRejectedValueOnce(new Error("Source revision changed"));
  expect(await f.controller.remove([source.sourceId])).toBe(false);
  await vi.waitFor(() => expect(f.client.listInformationBasket).toHaveBeenCalledTimes(2));
  expect(f.controller.snapshot().error).toBe("Source revision changed");
});

test("registration errors remain visible inside the still-open picker", async () => {
  const f = fixture(); await activate(f); await f.controller.picker.open();
  f.client.registerInformationBasketSources.mockRejectedValueOnce(new Error("Path is not readable"));
  f.controller.picker.setPath("/unreadable.md");
  expect(await f.controller.picker.addDraft()).toBe(false);
  expect(f.controller.snapshot().picker).toMatchObject({ open: true, error: "Path is not readable" });
});


test("chat upload opt-in is saved explicitly, reset locally and discarded on environment switch", async () => {
  const f = fixture(); await activate(f);
  f.controller.changeSettings("indexChatUploads", true);
  expect(f.client.saveInformationBasketSettings).not.toHaveBeenCalled();
  expect(f.controller.snapshot().settingsDraft.indexChatUploads).toBe(true);
  f.controller.resetSettings();
  expect(f.controller.snapshot().settingsDraft.indexChatUploads).toBe(false);
  f.controller.changeSettings("indexChatUploads", true);
  await f.controller.saveSettings();
  expect(f.client.saveInformationBasketSettings).toHaveBeenCalledWith({ expectedRevision: 2,
    enabled: true, matchMode: "balanced", embeddingProfileId: "local-embed", indexChatUploads: true }, "dev");
  f.controller.changeSettings("indexChatUploads", true);
  await f.setEnvironment("prod");
  expect(f.controller.snapshot().settingsDraft.indexChatUploads).toBe(false);
  expect(f.controller.snapshot().settingsDirty).toBe(false);
});


test("matching mode stays a draft until Save and Reset restores the server choice", async () => {
  const f = fixture(); await activate(f);
  expect(f.controller.snapshot().settingsDraft.matchMode).toBe("balanced");
  f.controller.changeSettings("matchMode", "strict");
  expect(f.controller.snapshot().settingsDraft.matchMode).toBe("strict");
  expect(f.client.saveInformationBasketSettings).not.toHaveBeenCalled();
  f.controller.resetSettings();
  expect(f.controller.snapshot().settingsDraft.matchMode).toBe("balanced");
  f.controller.changeSettings("matchMode", "flexible");
  await f.controller.saveSettings();
  expect(f.client.saveInformationBasketSettings).toHaveBeenCalledExactlyOnceWith({
    expectedRevision: 2, enabled: true, indexChatUploads: false, embeddingProfileId: "local-embed", matchMode: "flexible",
  }, "dev");
});
