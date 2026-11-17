import { afterEach, expect, test, vi } from "vitest";
import { ComposerSubmissionRefused } from "../app/controllers/composer-submission-lifecycle.js";
import { composerProductFixture, deferred } from "./__tests__/composer-product-fixture.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const image = { id: "image-1", name: "screen.png", storageRef: "chat-1/image-1", mimeType: "image/png", sessionId: "chat-1", environment: "prod" };
const document = { ...image, id: "doc-1", name: "notes.txt", storageRef: "chat-1/doc-1", mimeType: "text/plain" };
const imageFile = () => Object.assign(new Blob(["pixels"], { type: "image/png" }), { name: "screen.png" });

test.each(["Chat", "Home"])("%s reports an unavailable model without taking or submitting the draft", async (surface) => {
  const unavailable = new Error("The session model is unavailable. Choose a model before sending.");
  const f = await composerProductFixture({ getSettings: () => { throw unavailable; } });
  if (surface === "Home") f.showHome();
  const draft = surface === "Home" ? f.workspace.homeDraft() : f.workspace.chatDraft();
  draft.attachments = [document];
  f.type("Keep this draft");
  const take = vi.spyOn(draft, "take");
  const dispatch = surface === "Home" ? f.home.dispatch : f.composer.submit.dispatch;
  let sending: Promise<unknown> | undefined;
  expect(() => { sending = dispatch(); }).not.toThrow();
  expect(await sending).toMatchObject({ status: "blocked", error: unavailable });
  expect(f.statuses.at(-1)).toBe(unavailable.message);
  expect(take).not.toHaveBeenCalled();
  expect(draft.text).toBe("Keep this draft");
  expect(f.dom.composerInput.value).toBe("Keep this draft");
  expect(draft.attachments).toEqual([document]);
  expect(f.requests).toEqual([]);
  expect(f.composer.lifecycle.hasPendingScope(draft.scope)).toBe(false);
  expect(f.composer.lifecycle.paused(draft.scope)).toEqual([]);
});

test.each(["Chat", "Home", "Send next"])("%s retains images after a model switch and blocks before take or transport", async (surface) => {
  let supportsImages = true;
  const f = await composerProductFixture({ supportsImages: () => supportsImages });
  if (surface === "Home") f.showHome();
  if (surface === "Send next") f.state.activeRequestId = "running";
  const draft = surface === "Home" ? f.workspace.homeDraft() : f.workspace.chatDraft();
  const attachments = surface === "Home" ? f.home.attachments : f.composer.attachments;
  draft.attachments = [image];
  f.type("Describe this image");
  supportsImages = false;
  attachments.render();
  const take = vi.spyOn(draft, "take");
  const enqueue = vi.spyOn(f.queueStore, "enqueue");
  const deletion = vi.spyOn(f.client, "deleteAttachment");
  const dispatch = surface === "Home" ? f.home.dispatch : () => f.composer.submit.dispatch(surface === "Send next" ? "send_next" : "send");
  expect(await dispatch()).toMatchObject({ status: "blocked", error: expect.any(ComposerSubmissionRefused) });
  expect(f.statuses.at(-1)).toContain("Choose an image-capable model or remove the images");
  expect(f.dom.attachmentButton.title).toContain("does not accept images");
  expect(take).not.toHaveBeenCalled();
  expect(draft.text).toBe("Describe this image");
  expect(draft.attachments).toEqual([image]);
  expect(f.requests).toEqual([]);
  expect(enqueue).not.toHaveBeenCalled();
  expect(deletion).not.toHaveBeenCalled();
  expect(f.composer.lifecycle.paused(draft.scope)).toEqual([]);
  if (surface === "Send next") return;
  supportsImages = true;
  attachments.render();
  const sending = dispatch();
  expect(f.dom.composerInput.value).toBe("");
  expect((await sending).status).toBe("accepted");
  expect(f.requests).toEqual([expect.objectContaining({ text: "Describe this image", attachments: [image] })]);
});

test("text-only models still send documents, while image kind cannot bypass the MIME check", async () => {
  const f = await composerProductFixture({ supportsImages: () => false });
  const draft = f.workspace.chatDraft();
  draft.attachments = [{ ...document, kind: "image" }];
  f.type("Check attachment");
  expect((await f.composer.submit.dispatch()).status).toBe("blocked");
  draft.attachments = [document];
  expect((await f.composer.submit.dispatch()).status).toBe("accepted");
  expect(f.requests).toEqual([expect.objectContaining({ text: "Check attachment", attachments: [document] })]);
});

test.each([false, true])("an image upload stays with its original draft after model change (navigate=%s)", async (navigate) => {
  let supportsImages = true;
  const f = await composerProductFixture({ supportsImages: () => supportsImages });
  const draft = f.workspace.chatDraft();
  f.type("Inspect upload");
  const uploaded = deferred<typeof image>();
  vi.spyOn(f.client, "uploadAttachment").mockReturnValueOnce(uploaded.promise);
  const deletion = vi.spyOn(f.client, "deleteAttachment");
  const uploading = f.composer.attachments.upload(imageFile());
  supportsImages = false;
  if (navigate) f.switchSession("other-chat");
  uploaded.resolve(image);
  await uploading;
  expect(draft.attachments).toEqual([image]);
  expect(draft.uploading).toBe(0);
  expect(deletion).not.toHaveBeenCalled();
  if (navigate) {
    expect(f.workspace.chatDraft().attachments).toEqual([]);
    f.switchSession("chat-1");
  }
  expect((await f.composer.submit.dispatch()).status).toBe("blocked");
  expect(draft.text).toBe("Inspect upload");
  expect(f.requests).toEqual([]);
});

test("a reset still rejects and cleans up a completed upload from its invalidated draft generation", async () => {
  const f = await composerProductFixture();
  const draft = f.workspace.chatDraft();
  const uploaded = deferred<typeof image>();
  vi.spyOn(f.client, "uploadAttachment").mockReturnValueOnce(uploaded.promise);
  const deletion = vi.spyOn(f.client, "deleteAttachment").mockResolvedValue();
  const uploading = f.composer.attachments.upload(imageFile());
  f.workspace.drafts.resetSessionData(draft.scope);
  uploaded.resolve(image);
  await uploading;
  expect(draft.attachments).toEqual([]);
  expect(draft.uploading).toBe(0);
  expect(deletion).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "chat-1", id: image.id }));
});

test("accepted cleanup runs before binding and cannot turn a known send into a rejection", async () => {
  const accepted = vi.fn(() => { throw new Error("Cleanup failed"); });
  const f = await composerProductFixture({ onSubmissionAccepted: accepted });
  f.type("Send once");
  const bind = vi.spyOn(f.composer.queue, "bindAccepted");
  expect((await f.composer.submit.dispatch()).status).toBe("accepted");
  expect(accepted).toHaveBeenCalledOnce();
  expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ phase: "accepted", payload: expect.objectContaining({ text: "Send once" }) }));
  expect(accepted.mock.invocationCallOrder[0]).toBeLessThan(bind.mock.invocationCallOrder[0]!);
  expect(f.requests).toHaveLength(1);
  expect(f.activated).toEqual(["request-1"]);
  expect(f.workspace.chatDraft().isEmpty()).toBe(true);
});
