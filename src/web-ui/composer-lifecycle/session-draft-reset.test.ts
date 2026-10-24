import { describe, expect, test, vi } from "vitest";
import { createComposerDrafts } from "../app/controllers/composer-drafts.js";
import type { ComposerScope } from "../app/controllers/composer-drafts.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createSessionController } from "../app/controllers/session-controller.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const original = { environmentId: "prod", sessionId: "A" };
const other = { environmentId: "prod", sessionId: "B" };
const file = (scope: ComposerScope, id = "file") => ({
  id, storageRef: `${scope.sessionId}/${id}`, sessionId: scope.sessionId, environment: scope.environmentId,
});

function fixture(confirmAction: () => boolean | Promise<boolean> = () => true) {
  let environment = "prod";
  const ack = deferred();
  const drafts = createComposerDrafts();
  const draft = drafts.open(original);
  draft.text = "Keep this unsent text";
  draft.attachments = [file(original)];
  const destination = drafts.open(other);
  destination.text = "Other draft";
  destination.attachments = [file(other)];
  const state = {
    currentSessionId: "B", sessions: [{ id: "A" }, { id: "B" }],
    sessionQuery: "", pinnedSessionIds: [], sessionModels: { A: "model-A" }, busySessionIds: new Set<string>(),
  };
  const preferences = {
    savePinnedSessions: vi.fn(async () => {}), sessionIdForEnvironment: vi.fn(() => "A"),
    saveSessionIdForEnvironment: vi.fn(),
  };
  const client = {
    clearSessionMessages: vi.fn(() => ack.promise), deleteSession: vi.fn(() => ack.promise),
    deleteAttachment: vi.fn(),
  };
  const onClearCurrent = vi.fn();
  const onClearSessionMode = vi.fn();
  const onSaveModelPreferences = vi.fn();
  const onReload = vi.fn();
  const onControlEvent = vi.fn();
  const onSessionAttachmentsCleared = vi.fn((scope: ComposerScope) => drafts.clearAttachments(scope));
  const sessionActionsMenu = { reset: vi.fn() };
  const controller = createSessionController({
    state, preferences, client, selectedEnvironmentId: () => environment,
    dom: { sessionsList: { innerHTML: "", scrollTop: 0 }, sessionsCount: { textContent: "" } },
    sessionActionsMenu, renderGroups: () => true,
    shell: { showToast: vi.fn() }, confirmAction, copyText: vi.fn(), onOpen: vi.fn(),
    onClearCurrent, onClearSessionMode, onSaveModelPreferences, onReload, onControlEvent, onSessionAttachmentsCleared,
  });
  return { controller, ack, drafts, draft, destination, state, preferences, client, sessionActionsMenu,
    onClearCurrent, onClearSessionMode, onSaveModelPreferences, onReload, onControlEvent, onSessionAttachmentsCleared,
    setEnvironment: (value: string) => { environment = value; },
  };
}

test("Reset ACK clears files from parked A while preserving its text and the displayed B draft", async () => {
  const f = fixture();
  const clearing = f.controller.clearMessages("A");
  expect(f.draft.attachments).toEqual([file(original)]);
  expect(f.onSessionAttachmentsCleared).not.toHaveBeenCalled();
  f.ack.resolve();
  await clearing;
  expect(f.client.clearSessionMessages).toHaveBeenCalledExactlyOnceWith("A", "prod");
  expect(f.onSessionAttachmentsCleared).toHaveBeenCalledExactlyOnceWith(original);
  expect(f.draft.attachments).toEqual([]);
  expect(f.draft.text).toBe("Keep this unsent text");
  expect(f.destination.attachments).toEqual([file(other)]);
  expect(f.destination.text).toBe("Other draft");
  expect(f.onClearCurrent).not.toHaveBeenCalled();
  expect(f.client.deleteAttachment).not.toHaveBeenCalled();
});

describe.each(["clearMessages", "deleteSession"] as const)("%s", (action) => {
  test("late ACK cleans only its captured environment and does not alter the new environment view", async () => {
    const f = fixture();
    const waiting = f.controller[action]("A");
    await vi.waitFor(() => expect(action === "clearMessages" ? f.client.clearSessionMessages : f.client.deleteSession).toHaveBeenCalledOnce());
    const devScope = { environmentId: "dev", sessionId: "A" };
    const devDraft = f.drafts.open(devScope);
    devDraft.text = "Dev input";
    devDraft.attachments = [file(devScope)];
    f.setEnvironment("dev");
    f.state.currentSessionId = "A";
    const sessions = [{ id: "A" }, { id: "dev-only" }];
    f.state.sessions = sessions;
    f.sessionActionsMenu.reset.mockClear();
    f.ack.resolve();
    await waiting;
    expect(f.onSessionAttachmentsCleared).toHaveBeenCalledExactlyOnceWith(original);
    expect(f.draft.attachments).toEqual([]);
    expect(f.draft.text).toBe("Keep this unsent text");
    expect(devDraft.attachments).toEqual([file(devScope)]);
    expect(devDraft.text).toBe("Dev input");
    expect(f.state.sessions).toBe(sessions);
    expect(f.state.sessionModels).toEqual({ A: "model-A" });
    expect(f.onClearCurrent).not.toHaveBeenCalled();
    expect(f.onClearSessionMode).not.toHaveBeenCalled();
    expect(f.onSaveModelPreferences).not.toHaveBeenCalled();
    expect(f.preferences.saveSessionIdForEnvironment).not.toHaveBeenCalled();
    expect(f.onReload).not.toHaveBeenCalled();
    expect(f.sessionActionsMenu.reset).not.toHaveBeenCalled();
  });

  test("server refusal leaves the complete draft and upload generation intact", async () => {
    const f = fixture();
    const generation = f.draft.generation;
    const waiting = f.controller[action]("A");
    f.ack.reject(new Error("Refused"));
    await waiting;
    expect(f.draft.text).toBe("Keep this unsent text");
    expect(f.draft.attachments).toEqual([file(original)]);
    expect(f.draft.generation).toBe(generation);
    expect(f.onSessionAttachmentsCleared).not.toHaveBeenCalled();
    expect(f.onControlEvent).toHaveBeenCalledWith(expect.objectContaining({ summary: "Refused" }));
  });
});

test("Reset ACK retires the parked draft upload generation without discarding newer text", async () => {
  const f = fixture();
  const generation = f.draft.startUpload();
  const clearing = f.controller.clearMessages("A");
  f.draft.text = "Edited while reset waited";
  f.ack.resolve();
  await clearing;
  expect(f.draft.acceptUpload(generation, file(original, "late"))).toBe(false);
  f.draft.finishUpload(generation);
  expect(f.draft.attachments).toEqual([]);
  expect(f.draft.uploading).toBe(0);
  expect(f.draft.text).toBe("Edited while reset waited");
});

test("Delete ACK also clears the parked draft attachments without a second server cleanup", async () => {
  const f = fixture();
  const deleting = f.controller.deleteSession("A");
  f.ack.resolve();
  await deleting;
  expect(f.client.deleteSession).toHaveBeenCalledExactlyOnceWith("A", "prod");
  expect(f.onSessionAttachmentsCleared).toHaveBeenCalledExactlyOnceWith(original);
  expect(f.draft.attachments).toEqual([]);
  expect(f.draft.text).toBe("Keep this unsent text");
  expect(f.destination.attachments).toEqual([file(other)]);
  expect(f.state.sessions).toEqual([{ id: "B" }]);
  expect(f.client.deleteAttachment).not.toHaveBeenCalled();
});

test("clearing an unopened scope does not create or invalidate a draft", () => {
  const drafts = createComposerDrafts();
  const changed = vi.fn();
  drafts.subscribe(changed);
  expect(drafts.clearAttachments(original)).toEqual([]);
  expect(changed).not.toHaveBeenCalled();
  expect(drafts.open(original).generation).toBe(0);
  expect(drafts.open(original).revision).toBe(0);
});

describe.each(["clearMessages", "deleteSession"] as const)("%s confirmation", (action) => {
  test.each(["cancel", "environment", "conversation", "removed"] as const)(
    "pending approval preserves drafts and refuses a stale %s target", async (change) => {
      let approve!: (value: boolean) => void;
      const confirmation = new Promise<boolean>((resolve) => { approve = resolve; });
      const f = fixture(() => confirmation);
      const waiting = f.controller[action]("A");
      expect(f.client.clearSessionMessages).not.toHaveBeenCalled();
      expect(f.client.deleteSession).not.toHaveBeenCalled();
      expect(f.state.busySessionIds.size).toBe(0);
      if (change === "environment") f.setEnvironment("dev");
      if (change === "conversation") f.state.currentSessionId = "A";
      if (change === "removed") f.state.sessions = [{ id: "B" }];
      approve(change !== "cancel");
      await waiting;
      expect(f.client.clearSessionMessages).not.toHaveBeenCalled();
      expect(f.client.deleteSession).not.toHaveBeenCalled();
      expect(f.draft.attachments).toEqual([file(original)]);
      expect(f.onSessionAttachmentsCleared).not.toHaveBeenCalled();
    },
  );
  test("approved unchanged target starts one mutation only after the dialog settles", async () => {
    let approve!: (value: boolean) => void;
    const f = fixture(() => new Promise<boolean>((resolve) => { approve = resolve; }));
    const waiting = f.controller[action]("A");
    expect(f.client.clearSessionMessages).not.toHaveBeenCalled();
    expect(f.client.deleteSession).not.toHaveBeenCalled();
    approve(true);
    await vi.waitFor(() => expect(action === "clearMessages" ? f.client.clearSessionMessages : f.client.deleteSession).toHaveBeenCalledOnce());
    f.ack.resolve();
    await waiting;
    expect(f.onSessionAttachmentsCleared).toHaveBeenCalledExactlyOnceWith(original);
  });
});
