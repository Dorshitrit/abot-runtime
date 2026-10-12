import { afterEach, describe, expect, test, vi } from "vitest";
import { createComposerProductionHarness } from "./support/composer-production-harness.js";
afterEach(() => vi.unstubAllGlobals());

describe("web ui Home composer lifecycle", () => {
  test("initializes one Home draft per environment without changing existing Chat", () => {
    const h = createComposerProductionHarness();
    expect(h.onSessionCreated).not.toHaveBeenCalled();
    h.feature.setWorkspace("home");
    const draft = h.workspace.homeDraft();
    h.type("Draft");
    expect(h.onSessionCreated).toHaveBeenCalledExactlyOnceWith("home-session-1");
    expect(h.workspace.ensureHomeSession()).toBe(draft.scope.sessionId);
    expect(h.workspace.homeDraft().text).toBe("Draft");
    expect(h.state.currentSessionId).toBe("existing-chat");
    h.workspace.finishHomeActivation(draft.scope);
    expect(h.workspace.ensureHomeSession()).toBe("home-session-2");
  });

  test("moves the shared controls and parks Chat text and attachments intact", () => {
    const h = createComposerProductionHarness();
    const originalAttachments = h.workspace.chatDraft().attachments;
    const messages = h.state.messages;
    h.feature.setWorkspace("home");
    expect(h.dom.composerForm.parentElement).toBe(h.homeHost);
    expect(h.dom.runtimeSetupGuide.parentElement).toBe(h.homeSetupHost);
    expect(h.dom.composerInput.value).toBe("");
    expect(h.workspace.composerSessionId()).toBe("home-session-1");
    expect(h.state.activeRequestId).toBe("existing-request");
    expect(h.workspace.chatDraft().attachments).toEqual(originalAttachments);
    expect(h.state.messages).toBe(messages);
    expect(h.composerActions.render).toHaveBeenLastCalledWith(expect.objectContaining({ activeRequestId: "", queuedCount: 0 }));
    h.type("A separate Home draft");
    h.feature.setWorkspace("chat");
    expect(h.dom.composerForm.parentElement).toBe(h.chatHost);
    expect(h.dom.composerInput.value).toBe("Existing chat draft");
    h.feature.setWorkspace("home");
    expect(h.dom.composerInput.value).toBe("A separate Home draft");
  });

  test("restores a definitely refused queued message to Chat without changing Home", async () => {
    const h = createComposerProductionHarness();
    h.enqueue("Queued follow-up");
    h.client.postChatMessage.mockRejectedValueOnce(Object.assign(new Error("Invalid request"), { status: 400 }));
    h.feature.setWorkspace("home");
    h.type("My new Home question");
    await h.queue.drain({ environmentId: "dev", sessionId: "existing-chat", terminalRequestId: "existing-request" });
    expect(h.dom.composerInput.value).toBe("My new Home question");
    expect(h.workspace.homeDraft().attachments).toEqual([]);
    expect(h.workspace.chatDraft().attachments.map((file) => file.id)).toEqual(["chat-file"]);
    h.feature.setWorkspace("chat");
    expect(h.dom.composerInput.value).toBe("Queued follow-up\nExisting chat draft");
    expect(h.client.postChatMessage).toHaveBeenCalledOnce();
  });

  test("keeps a Chat upload completing on Home in its source draft", async () => {
    const h = createComposerProductionHarness();
    const upload = h.chatAttachments.upload(Object.assign(new Blob(["chat file"], { type: "text/plain" }), { name: "chat.txt" }));
    h.feature.setWorkspace("home");
    h.type("Home question");
    await upload;
    expect(h.workspace.chatDraft().attachments).toHaveLength(2);
    expect(h.workspace.homeDraft().attachments).toEqual([]);
    expect(h.dom.composerInput.value).toBe("Home question");
  });

  test("uploads into a new Home session and sends through the shared request path", async () => {
    const h = createComposerProductionHarness();
    h.feature.setWorkspace("home");
    const homeSessionId = h.workspace.composerSessionId();
    await h.feature.upload(Object.assign(new Blob(["document"], { type: "text/plain" }), { name: "notes.txt" }));
    expect(h.client.uploadAttachment).toHaveBeenCalledWith(expect.objectContaining({ sessionId: homeSessionId, environmentId: "dev" }));
    expect(h.state.currentSessionId).toBe("existing-chat");
    expect(h.workspace.chatDraft().attachments[0].id).toBe("chat-file");
    h.type("Summarize this document");
    await h.feature.dispatch();
    expect(h.workspace.isChatVisible()).toBe(true);
    expect(h.state.currentSessionId).toBe(homeSessionId);
    expect(h.client.postChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: "Summarize this document", attachments: [expect.objectContaining({ id: "home-file", sessionId: homeSessionId })],
      environmentId: "dev", sessionId: homeSessionId, agentMode: "reasoning", toolPermissionMode: "ask",
      modelPreference: { profileId: "selected-model" },
    }));
    expect(h.state.activeRequestId).toBe("new-request");
    h.feature.setWorkspace("home");
    expect(h.workspace.composerSessionId()).not.toBe(homeSessionId);
    expect(h.dom.composerInput.value).toBe("");
  });

  test("starts a fresh Home draft after activation while its prior POST is pending", async () => {
    const h = createComposerProductionHarness();
    let resolve!: (id: string) => void;
    h.client.postChatMessage.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    h.feature.setWorkspace("home");
    h.type("First message");
    const sending = h.feature.dispatch();
    await vi.waitFor(() => expect(h.client.postChatMessage).toHaveBeenCalledOnce());
    h.feature.setWorkspace("home");
    h.type("Another new conversation");
    h.feature.submit.updateSendState();
    expect(h.composerActions.render).toHaveBeenLastCalledWith(expect.objectContaining({ busy: false, disabled: false }));
    resolve("accepted-request");
    await sending;
    expect(h.dom.composerInput.value).toBe("Another new conversation");
    expect(h.workspace.homeDraft().text).toBe("Another new conversation");
  });

  test("retains the complete Home draft when Chat activation is blocked", async () => {
    const h = createComposerProductionHarness();
    h.feature.setWorkspace("home");
    const draft = h.workspace.homeDraft();
    draft.attachments = [{ id: "home-file" }];
    h.activateHomeSession.mockReturnValueOnce(false);
    h.type("Keep this draft");
    expect(await h.feature.dispatch()).toMatchObject({ status: "refused" });
    expect(h.client.postChatMessage).not.toHaveBeenCalled();
    expect(h.state.currentSessionId).toBe("existing-chat");
    expect(h.workspace.composerSessionId()).toBe(draft.scope.sessionId);
    expect(h.dom.composerInput.value).toBe("Keep this draft");
    expect(draft.attachments).toEqual([{ id: "home-file" }]);
  });

  test("keeps an unconfirmed Home send and files paused instead of silently restoring it", async () => {
    const h = createComposerProductionHarness();
    h.feature.setWorkspace("home");
    const scope = h.workspace.homeDraft().scope;
    await h.feature.upload(Object.assign(new Blob(["document"], { type: "text/plain" }), { name: "notes.txt" }));
    h.client.postChatMessage.mockRejectedValueOnce(new Error("Offline"));
    h.type("Send this");
    expect(await h.feature.dispatch()).toMatchObject({ status: "uncertain" });
    const paused = h.composer.lifecycle.paused(scope);
    expect(paused).toHaveLength(1);
    expect(paused[0].payload.attachments).toEqual([expect.objectContaining({ id: "home-file", sessionId: scope.sessionId })]);
    expect(h.workspace.chatDraft().attachments).toEqual([]);
    expect(h.client.deleteAttachment).not.toHaveBeenCalled();
    expect(h.client.postChatMessage).toHaveBeenCalledOnce();
  });

  test("parks a Home upload in its source environment instead of deleting it on navigation", async () => {
    const h = createComposerProductionHarness();
    h.feature.setWorkspace("home");
    const original = h.workspace.homeDraft();
    let resolve!: (file: { id: string; storageRef: string; mimeType: string }) => void;
    h.client.uploadAttachment.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const upload = h.feature.upload(Object.assign(new Blob(["document"], { type: "text/plain" }), { name: "notes.txt" }));
    h.setEnvironmentId("prod");
    h.feature.environmentChanged();
    resolve({ id: "late-file", storageRef: `${original.scope.sessionId}/late-file`, mimeType: "text/plain" });
    await upload;
    expect(h.workspace.homeDraft().attachments).toEqual([]);
    expect(h.workspace.homeDraft().scope.environmentId).toBe("prod");
    expect(original.attachments).toEqual([expect.objectContaining({ id: "late-file", environment: "dev" })]);
    expect(h.client.deleteAttachment).not.toHaveBeenCalled();
  });
});
