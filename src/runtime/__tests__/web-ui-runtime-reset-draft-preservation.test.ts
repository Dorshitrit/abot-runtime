import { afterEach, expect, test, vi } from "vitest";
import { createComposerProductionHarness } from "./support/composer-production-harness.js";
import { createConversationSessionController } from "../../web-ui/app/controllers/conversation-session-controller.js";
// @ts-expect-error Browser state module.
import { createAppState } from "../../web-ui/app/app-state.js";
// @ts-expect-error Browser maintenance feature.
import { createRuntimeMaintenanceFeature } from "../../web-ui/app/runtime-maintenance-feature.js";
// @ts-expect-error Browser reset reconciliation.
import { reconcileRuntimeSessionReset } from "../../web-ui/app/controllers/runtime-session-reset-view.js";

vi.mock("../../web-ui/app/components/confirmation-dialog.js", () => ({ confirmDialog: async () => true }));
vi.mock("../../web-ui/app/components/runtime-maintenance.js", () => ({ createRuntimeMaintenanceView: () => ({ render() {} }) }));
vi.mock("../../web-ui/app/services/workspace-state.js", () => ({ workspaceQueue: () => ({ async refresh() {} }) }));
afterEach(() => { vi.unstubAllGlobals(); });

const originalText = "  Keep this exact draft\nעברית\n\n";
const result = { resetId: "reset-one", complete: true, deletedSessionIds: ["existing-chat"], clearedSessionIds: [], failedSessionIds: [], deletedMessages: 1, deletedRequests: 0 };
function fixture(occupied: boolean) {
  const h = createComposerProductionHarness();
  const state = Object.assign(h.state, createAppState(), { currentSessionId: "existing-chat", sessions: [{ id: "existing-chat" }] });
  let environmentId = "dev";
  const selected = new Map([["dev", "existing-chat"], ["prod", "prod-chat"]]);
  const preferences = {
    sessionIdForEnvironment: (scope: string) => selected.get(scope) ?? "",
    saveSessionIdForEnvironment: vi.fn((scope: string, id: string) => { selected.set(scope, id); }),
    loadSessionSidebar: () => ({ archivedSessionIds: [], orderedSessionIds: [] }),
    saveSessionSidebar: vi.fn(), saveSessionModes: vi.fn(), saveModelPreferences: vi.fn(),
  };
  const client = { ...h.client, supportsRuntimeMaintenance: () => true,
    resetRuntimeSessions: vi.fn(async () => ({ ok: true, result })),
    listSessions: vi.fn(async () => ({ sessions: [] })), loadSession: vi.fn(async () => ({ messages: [], requests: [] })),
    markSessionRead: vi.fn(async () => ({})), fetchRequestEvents: vi.fn(async () => []) };
  const conversation = createConversationSessionController({
    state, client, dom: { sessionTitle: { textContent: "" }, sessionsList: { innerHTML: "" } }, preferences,
    sessions: { byId: () => ({}), titleOf: () => "", setCurrentTitle() {}, applyTitle() {}, applyReadState() {} },
    sessionQueue: h.sessionQueue, conversationView: { reset() {} }, selectedEnvironmentId: () => environmentId,
    applyConversationChrome() {}, applyModelSelection() {}, renderSessions() {}, renderMessages() {},
    updateComposerSendState: () => { h.workspace.syncChatDraft(); h.composer.changed(); },
    setMessageStatus() {}, sendRealtime() {}, handleRealtimeMessage() {}, recordEvent() {}, recordControlEvent() {},
    reportQueueFailure() {}, drainQueuedMessage() {}, suspendQueueRecovery: () => true, recoverBlockedQueue() {}, isCurrentComposerScope: () => true,
  });
  const maintenance = createRuntimeMaintenanceFeature({ root: {}, client, getEnvironmentId: () => environmentId,
    onSessionsReset: (reset: typeof result, scope: string) => reconcileRuntimeSessionReset({
      result: reset, environmentId: scope, getEnvironmentId: () => environmentId, state, preferences,
      clearSessionDraft: (draftScope: { environmentId: string; sessionId: string }, deleted: boolean) => h.workspace.resetSessionDraft(draftScope, deleted),
      preserveSessionDraft: (draftScope: { environmentId: string; sessionId: string }) => h.workspace.preserveResetDraft(draftScope),
      restoreSessionDraft: (sessionId: string) => h.workspace.restoreResetDraft(sessionId),
      refreshComposer: h.composer.changed, clearCurrentSession: conversation.clearCurrentSessionView,
      loadSessions: conversation.loadSessions, refreshDashboard: async () => {}, forgetDeletedSessionPins: async () => {},
    }) });
  const empty = h.workspace.drafts.open({ environmentId: "dev", sessionId: "" });
  if (occupied) empty.text = "Existing new-conversation draft";
  h.workspace.drafts.open({ environmentId: "prod", sessionId: "prod-chat" }).text = "Prod must stay intact";
  h.type(originalText);
  async function receive(source: string) {
    if (source === "local") await maintenance.reset("sessions");
    else await maintenance.observeRealtimeMessage({ type: "workspace_changed", environment: "dev", sessionReset: result });
  }
  async function switchEnvironment(next: string, sessionId = "") {
    conversation.clearCurrentSessionView();
    environmentId = next; state.currentSessionId = sessionId; h.setEnvironmentId(next); maintenance.environmentChanged();
    if (!sessionId && !h.workspace.restoreResetDraft(preferences.sessionIdForEnvironment(next))) await conversation.restoreLastSession();
  }
  return { ...h, state, client, maintenance, conversation, preferences, empty, receive, switchEnvironment };
}

test.each(["local", "remote"])("%s reset keeps selected draft accessible in vacant new-conversation scope", async (source) => {
  const h = fixture(false);
  await h.receive(source);
  expect(h.state.currentSessionId).toBe("");
  expect(h.dom.composerInput.value).toBe(originalText);
  expect(h.workspace.chatDraft().attachments).toEqual([]);
  expect(h.workspace.drafts.open({ environmentId: "dev", sessionId: "existing-chat" }).text).toBe("");
  expect(h.preferences.sessionIdForEnvironment("dev")).toBe("");
  await h.composer.submit.dispatch();
  await vi.waitFor(() => expect(h.client.postChatMessage).toHaveBeenCalledOnce());
  expect(h.client.postChatMessage.mock.calls[0]![0]).toMatchObject({ text: originalText.trim(), sessionId: "created-chat", attachments: [] });
});

test.each(["local", "remote"])("%s reset keeps occupied empty-scope draft intact and uses a fresh accessible ID", async (source) => {
  const h = fixture(true);
  await h.receive(source);
  expect(h.state.currentSessionId).toBe("home-session-1");
  expect(h.dom.composerInput.value).toBe(originalText);
  expect(h.empty.text).toBe("Existing new-conversation draft");
  expect(h.workspace.chatDraft().attachments).toEqual([]);
  expect(h.preferences.sessionIdForEnvironment("dev")).toBe("home-session-1");
  await h.switchEnvironment("prod", "prod-chat");
  expect(h.dom.composerInput.value).toBe("Prod must stay intact");
  await h.switchEnvironment("dev");
  expect(h.dom.composerInput.value).toBe(originalText);
  expect(h.state.currentSessionId).toBe("home-session-1");
  expect(h.client.loadSession).not.toHaveBeenCalled();
});

test.each([false, true])("remote reset preserves inactive selected draft for return without touching prod (occupied: %s)", async (occupied) => {
  const h = fixture(occupied);
  await h.switchEnvironment("prod", "prod-chat");
  await h.receive("remote");
  expect(h.state.currentSessionId).toBe("prod-chat");
  expect(h.dom.composerInput.value).toBe("Prod must stay intact");
  expect(h.preferences.sessionIdForEnvironment("prod")).toBe("prod-chat");
  await h.switchEnvironment("dev");
  expect(h.dom.composerInput.value).toBe(originalText);
  expect(h.workspace.chatDraft().attachments).toEqual([]);
  if (occupied) expect(h.empty.text).toBe("Existing new-conversation draft");
});

test("a late local response preserves the captured environment draft without changing current selection", async () => {
  const h = fixture(true);
  let finish!: (value: { ok: boolean; result: typeof result }) => void;
  h.client.resetRuntimeSessions.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const pending = h.maintenance.reset("sessions");
  await vi.waitFor(() => expect(h.client.resetRuntimeSessions).toHaveBeenCalledOnce());
  await h.switchEnvironment("prod", "prod-chat");
  finish({ ok: true, result }); await pending;
  expect(h.dom.composerInput.value).toBe("Prod must stay intact");
  await h.switchEnvironment("dev");
  expect(h.dom.composerInput.value).toBe(originalText);
  expect(h.empty.text).toBe("Existing new-conversation draft");
});

test("duplicate reset notice preserves later edits and recovery never overrides a new saved selection", async () => {
  const h = fixture(true);
  await h.receive("remote"); h.type("User edits after reset");
  await h.receive("remote");
  expect(h.dom.composerInput.value).toBe("User edits after reset");
  await h.switchEnvironment("prod", "prod-chat");
  h.preferences.saveSessionIdForEnvironment("dev", "different-session");
  await h.switchEnvironment("dev");
  expect(h.client.loadSession).toHaveBeenCalledWith("different-session", "dev", expect.any(Object));
  expect(h.state.currentSessionId).toBe("different-session");
});

test("an uploading empty-scope draft is not reused by reset recovery", async () => {
  const h = fixture(false); const upload = h.empty.startUpload();
  await h.receive("remote");
  expect(h.state.currentSessionId).toBe("home-session-1");
  expect(h.empty.acceptUpload(upload, { id: "unrelated-upload" })).toBe(true);
  expect(h.workspace.chatDraft().attachments).toEqual([]);
  expect(h.dom.composerInput.value).toBe(originalText);
});

test.each(["local", "remote"])("%s reset moves uploaded Home draft to a usable fresh owner", async (source) => {
  const h = fixture(false); h.feature.setWorkspace("home"); h.type(originalText);
  await h.feature.upload(Object.assign(new Blob(["home upload"], { type: "text/plain" }), { name: "home.txt" }));
  const previousHome = h.workspace.ensureHomeSession();
  const homeReset = { ...result, deletedSessionIds: [previousHome] };
  h.client.resetRuntimeSessions.mockResolvedValue({ ok: true, result: homeReset });
  if (source === "local") await h.maintenance.reset("sessions");
  else await h.maintenance.observeRealtimeMessage({ type: "workspace_changed", environment: "dev", sessionReset: homeReset });
  expect(h.workspace.ensureHomeSession()).not.toBe(previousHome);
  expect(h.dom.composerInput.value).toBe(originalText);
  expect(h.workspace.homeDraft().attachments).toEqual([]);
  expect(h.state.currentSessionId).toBe("existing-chat");
  h.feature.dispatch();
  await vi.waitFor(() => expect(h.client.postChatMessage).toHaveBeenCalledOnce());
  expect(h.client.postChatMessage.mock.calls[0]![0]).toMatchObject({ text: originalText.trim(), sessionId: "home-session-2", attachments: [] });
});

test("reset of an inactive Home upload owner preserves other-environment Home draft and restores a fresh owner on return", async () => {
  const h = fixture(false); h.feature.setWorkspace("home"); h.type(originalText);
  await h.feature.upload(Object.assign(new Blob(["home upload"], { type: "text/plain" }), { name: "home.txt" }));
  const previousHome = h.workspace.ensureHomeSession();
  await h.switchEnvironment("prod", "prod-chat"); h.type("Keep prod Home text");
  const prodHome = h.workspace.ensureHomeSession();
  await h.maintenance.observeRealtimeMessage({ type: "workspace_changed", environment: "dev", sessionReset: { ...result, deletedSessionIds: [previousHome] } });
  expect(h.workspace.ensureHomeSession()).toBe(prodHome);
  expect(h.dom.composerInput.value).toBe("Keep prod Home text");
  await h.switchEnvironment("dev");
  expect(h.workspace.ensureHomeSession()).not.toBe(previousHome);
  expect(h.dom.composerInput.value).toBe(originalText);
  expect(h.workspace.homeDraft().attachments).toEqual([]);
});
