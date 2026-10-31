import { platformDocument } from "./document-reader-platform-fixtures.js";
import { readFile, rm } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { createInformationBasketService } from "../information-basket/service.js";
import { emptyBasketSnapshot } from "../information-basket/index-records.js";
import { parseBasketSnapshot } from "../information-basket/snapshot-validation.js";
import { createBasketChatUploadFixture } from "./support/basket-chat-upload-fixture.js";
import { fixtureEmbedding, waitForBasketSource } from "./support/information-basket-fixture.js";
import type { ModelGatewayEmbeddingParams } from "../../model-gateway/types.js";

const fixtures: Awaited<ReturnType<typeof createBasketChatUploadFixture>>[] = [];
async function fixture(...args: Parameters<typeof createBasketChatUploadFixture>) {
  const f = await createBasketChatUploadFixture(...args); fixtures.push(f); return f;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) { await f.close(); await rm(f.root, { recursive: true, force: true }); }
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("new and legacy stores default off; invalid saved values are rejected", () => {
  const snapshot = emptyBasketSnapshot("host");
  expect(snapshot.settings.indexChatUploads).toBe(false);
  const { indexChatUploads: _unused, ...settings } = snapshot.settings;
  expect(parseBasketSnapshot({ ...snapshot, settings }, "host").settings.indexChatUploads).toBe(false);
  expect(() => parseBasketSnapshot({ ...snapshot, settings: { ...settings, indexChatUploads: "true" } }, "host"))
    .toThrow("basket_storage_invalid");
});

test("only successful new opted-in uploads register their existing path, original name and one queued entry", async () => {
  const f = await fixture();
  expect((await f.upload("old.txt")).status).toBe(200);
  expect((await f.service.list()).sources).toEqual([]);
  await f.setUploads(true);
  expect((await f.service.list()).sources).toEqual([]);
  const receipt = await f.upload("Original notes.txt");
  expect(receipt.status).toBe(200);
  const attachment = receipt.body!.attachment;
  const resolved = await f.attachments.resolveAttachment(attachment);
  const view = await f.service.list();
  expect(view.sources).toHaveLength(1);
  expect(view.sources[0]).toMatchObject({ displayName: "Original notes.txt", path: resolved.absolutePath, status: "queued" });
  expect(await readFile(resolved.absolutePath, "utf8")).toBe("apple uploaded source");
  expect(f.embed).not.toHaveBeenCalled();
  await f.client.service.registerChatUpload({ sessionId: "chat-one", attachment, settingsRevision: view.settings.revision });
  expect((await f.service.list()).sources).toHaveLength(1);
  await f.setUploads(false);
  expect((await f.upload("later.txt")).status).toBe(200);
  expect((await f.service.list()).sources).toHaveLength(1);
});

test.each([false, true])("settings changes fence an upload already saving (initial opt-in %s)", async initial => {
  const f = await fixture();
  if (initial) await f.setUploads(true);
  const waiting = gate();
  const original = f.attachments.saveAttachment;
  const save = vi.spyOn(f.attachments, "saveAttachment").mockImplementation(async input => {
    await waiting.promise; return original(input);
  });
  const pending = f.upload();
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  if (initial) await f.setUploads(false);
  await f.setUploads(true);
  waiting.resolve();
  expect((await pending).status).toBe(200);
  expect((await f.service.list()).sources).toHaveLength(0);
});

test("unsupported uploads stay attachments and failed writes never register", async () => {
  const f = await fixture(); await f.setUploads(true);
  for (const [name, type] of [["photo.png", "image/png"], ["notes.txt", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], ["old.rtf", "application/rtf"]])
    expect((await f.upload(name, type)).status).toBe(200);
  expect((await f.service.list()).sources).toEqual([]);
  vi.spyOn(f.attachments, "saveAttachment").mockRejectedValueOnce(new Error("disk full"));
  expect((await f.upload()).status).toBe(500);
  expect((await f.service.list()).sources).toEqual([]);
});

test("upload success is independent of optional Resources admission or registration failure", async () => {
  const f = await fixture(); await f.setUploads(true);
  vi.spyOn(f.client.service, "captureChatUpload").mockRejectedValueOnce(new Error("owner disconnected"));
  expect((await f.upload()).status).toBe(200);
  vi.spyOn(f.client.service, "registerChatUpload").mockRejectedValueOnce(new Error("basket_source_count_limit"));
  const receipt = await f.upload();
  expect(receipt.status).toBe(200);
  expect(await f.attachments.resolveAttachment(receipt.body!.attachment)).toBeDefined();
  expect((await f.service.list()).sources).toEqual([]);
});

test("registration does not wait for embeddings and a preference-only change does not cancel indexing", async () => {
  const waiting = gate();
  const embed = vi.fn(async (input: ModelGatewayEmbeddingParams) => { await waiting.promise; return fixtureEmbedding(input); });
  const f = await fixture(embed); await f.setUploads(true, "fixture");
  const receipt = await f.upload();
  expect(receipt.status).toBe(200);
  const source = await waitForBasketSource(f.service, "indexing");
  await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
  const changed = vi.fn(); const unsubscribe = f.service.subscribeChanges(changed);
  await f.setUploads(false, "fixture");
  expect(changed).toHaveBeenLastCalledWith({ settingsChanged: false, invalidatedSourceIds: [], readySourcesAdded: false });
  expect((await f.service.list()).sources[0]).toMatchObject({ sourceId: source.sourceId, revision: source.revision, status: "indexing" });
  waiting.resolve();
  await waitForBasketSource(f.service);
  expect(embed).toHaveBeenCalledTimes(1);
  await f.attachments.deleteAttachment!(receipt.body!.attachment, { sessionId: "chat-one" });
  expect((await f.service.list({ verifySources: true })).sources).toEqual([]);
  expect((await f.service.list()).sources[0]!.status).toBe("missing");
  unsubscribe();
});

test("saved opt-in survives restart without importing existing attachments, and environments remain isolated", async () => {
  const f = await fixture(); const other = await fixture();
  await f.setUploads(true);
  const old = await other.upload();
  await f.service.stop();
  const reopened = createInformationBasketService({ config: f.config, models: { embed: f.embed }, attachments: f.attachments });
  try {
    await reopened.start();
    expect((await reopened.list()).settings.indexChatUploads).toBe(true);
    expect((await reopened.list()).sources).toEqual([]);
    expect((await other.service.list()).settings.indexChatUploads).toBe(false);
    await expect(reopened.registerChatUpload({ settingsRevision: (await reopened.list()).settings.revision,
      sessionId: "different-chat", attachment: old.body!.attachment })).rejects.toThrow();
    expect((await reopened.list()).sources).toEqual([]);
  } finally { await reopened.stop(); }
});

test("shutdown revokes a captured upload admission", async () => {
  const f = await fixture(); await f.setUploads(true);
  const settingsRevision = (await f.service.captureChatUpload())!;
  await f.service.stop();
  const attachment = await f.attachments.saveAttachment({ sessionId: "chat-one", requestId: "upload", kind: "file",
    mimeType: "text/plain", bytes: Buffer.from("apple"), name: "notes.txt" });
  await f.service.registerChatUpload({ settingsRevision, sessionId: "chat-one", attachment });
  expect((await f.service.list()).sources).toEqual([]);
  expect(await f.service.captureChatUpload()).toBeNull();
});


test.each(["preference", "disable-enable"])("in-flight retrieval fences only retrieval settings: %s", async change => {
  const f = await fixture(); await f.setUploads(true, "fixture");
  await f.upload(); await waitForBasketSource(f.service);
  const waiting = gate();
  f.embed.mockImplementationOnce(async input => { await waiting.promise; return fixtureEmbedding(input); });
  const pending = f.service.search({ query: "apple", abortSignal: new AbortController().signal });
  await vi.waitFor(() => expect(f.embed).toHaveBeenCalledTimes(2));
  if (change === "preference") await f.setUploads(false, "fixture");
  else {
    let view = await f.service.list();
    view = await f.service.updateSettings({ ...view.settings, expectedRevision: view.settings.revision, enabled: false });
    await f.service.updateSettings({ ...view.settings, expectedRevision: view.settings.revision, enabled: true });
  }
  waiting.resolve();
  expect((await pending).status).toBe(change === "preference" ? "found" : "unavailable");
});


test("foreign browser origins cannot add uploaded files to the personal source registry", async () => {
  const f = await fixture(); await f.setUploads(true);
  const capture = vi.spyOn(f.client.service, "captureChatUpload");
  expect((await f.upload("foreign.txt", "text/plain", { origin: "https://foreign.test" })).status).toBe(200);
  expect((await f.upload("cross-site.txt", "text/plain", { "sec-fetch-site": "cross-site" })).status).toBe(200);
  expect(capture).not.toHaveBeenCalled();
  expect((await f.service.list()).sources).toEqual([]);
});

test("new DOCX uploads use the same independent indexing and read path", async () => {
  const f = await fixture(); await f.setUploads(true, "fixture");
  const { bytes, expected } = await platformDocument("docx");
  const result = await f.upload("notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    {}, Uint8Array.from(bytes as Uint8Array).buffer);
  expect(result.status).toBe(200);
  const source = await waitForBasketSource(f.service);
  expect(source.displayName).toBe("notes.docx");
  expect((await f.service.readSource({ sourceId: source.sourceId, expectedRevision: source.revision })).text).toContain(expected);
});
