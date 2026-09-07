import { afterEach, describe, expect, test, vi } from "vitest";

import { createComposerWorkspaceHarness } from "./support/web-ui-composer-workspace-harness.js";

afterEach(() => vi.unstubAllGlobals());

describe("web ui Home composer lifecycle", () => {
  test("moves the same composer and keeps the active Chat draft and attachments intact", () => {
    const harness = createComposerWorkspaceHarness();
    const originalAttachments = harness.state.pendingAttachments;
    const originalMessages = harness.state.messages;
    harness.feature.setWorkspace("home");

    expect(harness.homeHost.appendChild).toHaveBeenCalledWith(harness.dom.composerForm);
    expect(harness.homeSetupHost.appendChild).toHaveBeenCalledWith(
      harness.dom.runtimeSetupGuide,
    );
    expect(harness.dom.composerInput.value).toBe("");
    expect(harness.workspace.composerSessionId()).toBe("home-session-1");
    expect(harness.state.currentSessionId).toBe("existing-chat");
    expect(harness.state.activeRequestId).toBe("existing-request");
    expect(harness.state.pendingAttachments).toBe(originalAttachments);
    expect(harness.state.messages).toBe(originalMessages);
    expect(harness.composerActions.render).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeRequestId: "", queuedCount: 0 }),
    );

    harness.dom.composerInput.value = "A separate Home draft";
    harness.feature.setWorkspace("chat");
    expect(harness.chatHost.insertBefore).toHaveBeenCalledWith(
      harness.dom.composerForm,
      harness.nextSibling,
    );
    expect(harness.dom.composerInput.value).toBe("Existing chat draft");
    harness.feature.setWorkspace("home");
    expect(harness.dom.composerInput.value).toBe("A separate Home draft");
  });

  test("restores a failed background queue to the Chat draft without changing Home", async () => {
    const harness = createComposerWorkspaceHarness();
    const scope = { environmentId: "dev", sessionId: "existing-chat" };
    harness.sessionQueue.enqueue(scope, {
      waitForRequestId: "existing-request",
      text: "Queued follow-up",
      attachments: [{ id: "queued-file", mimeType: "text/plain" }],
      agentMode: "reasoning",
      toolPermissionMode: "ask",
      modelPreference: { profileId: "selected-model" },
    });
    harness.feature.setWorkspace("home");
    harness.dom.composerInput.value = "My new Home question";

    await harness.queue.drain({ ...scope, terminalRequestId: "existing-request" });

    expect(harness.dom.composerInput.value).toBe("My new Home question");
    expect(harness.workspace.homeState.pendingAttachments).toEqual([]);
    expect(harness.state.pendingAttachments.map((file) => file.id)).toEqual([
      "queued-file", "chat-file",
    ]);
    harness.feature.setWorkspace("chat");
    expect(harness.dom.composerInput.value).toBe(
      "Queued follow-up\nExisting chat draft",
    );
  });

  test("keeps a Chat upload that completes on Home out of the visible attachment list", async () => {
    const harness = createComposerWorkspaceHarness();
    const upload = harness.chatAttachments.upload(
      Object.assign(new Blob(["chat file"], { type: "text/plain" }), { name: "chat.txt" }),
    );
    harness.feature.setWorkspace("home");
    harness.dom.composerInput.value = "Home question";
    harness.dom.attachmentPreview.appendChild.mockClear();

    await upload;

    expect(harness.state.pendingAttachments).toHaveLength(2);
    expect(harness.workspace.homeState.pendingAttachments).toEqual([]);
    expect(harness.dom.attachmentPreview.appendChild).not.toHaveBeenCalled();
    expect(harness.dom.composerInput.value).toBe("Home question");
  });

  test("uploads into a new session and sends through the existing Chat request path", async () => {
    const harness = createComposerWorkspaceHarness();
    harness.feature.setWorkspace("home");
    const homeSessionId = harness.workspace.composerSessionId();
    await harness.feature.upload(
      Object.assign(new Blob(["document"], { type: "text/plain" }), { name: "notes.txt" }),
    );
    expect(harness.client.uploadAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: homeSessionId, environmentId: "dev" }),
    );
    expect(harness.state.currentSessionId).toBe("existing-chat");
    expect(harness.state.pendingAttachments[0]?.id).toBe("chat-file");
    harness.dom.composerInput.value = "Summarize this document";

    harness.feature.dispatch();
    await vi.waitFor(() => expect(harness.client.postChatMessage).toHaveBeenCalledOnce());

    expect(harness.workspace.isChatVisible()).toBe(true);
    expect(harness.state.currentSessionId).toBe(homeSessionId);
    expect(harness.client.postChatMessage).toHaveBeenCalledWith({
      text: "Summarize this document",
      attachments: [expect.objectContaining({
        id: "home-file",
        sessionId: homeSessionId,
      })],
      environmentId: "dev",
      sessionId: homeSessionId,
      agentMode: "reasoning",
      toolPermissionMode: "ask",
      modelPreference: { profileId: "selected-model" },
    });
    expect(harness.workspace.homeState.pendingAttachments).toEqual([]);
    expect(harness.state.activeRequestId).toBe("new-request");
    harness.feature.setWorkspace("home");
    expect(harness.workspace.composerSessionId()).not.toBe(homeSessionId);
    expect(harness.dom.composerInput.value).toBe("");
  });

  test("starts a fresh Home draft while its previous message is awaiting HTTP acceptance", async () => {
    const harness = createComposerWorkspaceHarness();
    let resolveRequest!: (value: string) => void;
    harness.client.postChatMessage.mockReturnValueOnce(
      new Promise((resolve) => { resolveRequest = resolve; }),
    );
    harness.feature.setWorkspace("home");
    harness.dom.composerInput.value = "First message";
    harness.feature.dispatch();

    harness.feature.setWorkspace("home");
    harness.dom.composerInput.value = "Another new conversation";
    harness.feature.submit.updateSendState();
    expect(harness.workspace.homeState.composerSending).toBe(false);
    expect(harness.composerActions.render).toHaveBeenLastCalledWith(
      expect.objectContaining({ busy: false, disabled: false }),
    );

    resolveRequest("accepted-request");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.dom.composerInput.value).toBe("Another new conversation");
    expect(harness.workspace.homeState.composerSending).toBe(false);
  });

  test("retains the Home draft if Chat activation is blocked", async () => {
    const harness = createComposerWorkspaceHarness();
    harness.feature.setWorkspace("home");
    const homeSessionId = harness.workspace.composerSessionId();
    harness.workspace.homeState.pendingAttachments = [{ id: "home-file" }];
    harness.activateHomeSession.mockReturnValueOnce(false);
    harness.dom.composerInput.value = "Keep this draft";

    harness.feature.dispatch();
    await vi.waitFor(() => expect(harness.workspace.homeState.composerSending).toBe(false));

    expect(harness.client.postChatMessage).not.toHaveBeenCalled();
    expect(harness.state.currentSessionId).toBe("existing-chat");
    expect(harness.workspace.composerSessionId()).toBe(homeSessionId);
    expect(harness.dom.composerInput.value).toBe("Keep this draft");
    expect(harness.workspace.homeState.pendingAttachments).toEqual([{ id: "home-file" }]);
  });

  test("returns uploaded files to the new Chat when the send fails", async () => {
    const harness = createComposerWorkspaceHarness();
    harness.feature.setWorkspace("home");
    await harness.feature.upload(
      Object.assign(new Blob(["document"], { type: "text/plain" }), { name: "notes.txt" }),
    );
    harness.client.postChatMessage.mockRejectedValueOnce(new Error("Offline"));
    harness.dom.composerInput.value = "Send this";

    harness.feature.dispatch();
    await vi.waitFor(() => expect(harness.onControlEvent).toHaveBeenCalled());

    expect(harness.workspace.isChatVisible()).toBe(true);
    expect(harness.state.pendingAttachments).toEqual([
      expect.objectContaining({ id: "home-file", sessionId: "home-session-1" }),
    ]);
    expect(harness.onControlEvent).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Offline" }),
    );
    expect(harness.dom.composerInput.focus).not.toHaveBeenCalled();
  });

  test("invalidates a pending Home upload after changing environment", async () => {
    const harness = createComposerWorkspaceHarness();
    harness.feature.setWorkspace("home");
    let resolveUpload!: (value: {
      id: string; storageRef: string; mimeType: string;
    }) => void;
    harness.client.uploadAttachment.mockReturnValueOnce(
      new Promise((resolve) => { resolveUpload = resolve; }),
    );
    const upload = harness.feature.upload(
      Object.assign(new Blob(["document"], { type: "text/plain" }), { name: "notes.txt" }),
    );
    harness.setEnvironmentId("prod");
    harness.feature.environmentChanged();
    resolveUpload({
      id: "stale-file",
      storageRef: "home-session-1/stale-file",
      mimeType: "text/plain",
    });
    await upload;

    expect(harness.workspace.homeState.pendingAttachments).toEqual([]);
    expect(harness.workspace.homeState.environmentId).toBe("prod");
    expect(harness.client.deleteAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "dev",
        sessionId: "home-session-1",
        id: "stale-file",
      }),
    );
  });
});
