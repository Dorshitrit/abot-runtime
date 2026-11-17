import { afterEach, expect, test, vi } from "vitest";
import { conversationTitle } from "../../web-ui/app/lib/conversation-title.js";
import { createConversationSessionController, type ConversationSessionState } from "../../web-ui/app/controllers/conversation-session-controller.js";
import { createRealtimeEventController } from "../../web-ui/app/controllers/realtime-event-controller.js";
import { SidebarElement } from "./support/session-sidebar-dom.js";
// @ts-expect-error Browser-only controller.
import { createSessionController } from "../../web-ui/app/controllers/session-controller.js";

afterEach(() => vi.unstubAllGlobals());

test("unnamed and failed first conversations do not expose their storage identity", () => {
  const session = { id: "abot-web-generated", title: "abot-web-generated" };
  const dom = { sessionTitle: { textContent: "" } };
  const state = { currentSessionId: session.id, sessions: [session] };
  const controller = createSessionController({ state, dom, preferences: {}, selectedEnvironmentId: () => "dev" });
  expect(controller.titleOf(session)).toBe("Untitled conversation");
  controller.setCurrentTitle(session.id);
  expect(dom.sessionTitle.textContent).toBe("Untitled conversation");
  controller.setCurrentTitle("New conversation");
  expect(dom.sessionTitle.textContent).toBe("New conversation");
  expect(session.title).toBe(session.id);
});

test("explicit conversation names take precedence, including a user-selected identifier", () => {
  expect(conversationTitle({ id: "id", title: "Generated title", displayName: "Renamed chat" }))
    .toBe("Renamed chat");
  expect(conversationTitle({ id: "id", title: "Generated title" })).toBe("Generated title");
  expect(conversationTitle({ id: "id", title: "id", displayName: "id" })).toBe("id");
  expect(conversationTitle({ id: "id", title: "  " })).toBe("Untitled conversation");
});

test("opening, reopening and paging preserve the list fallback until a real title event arrives", async () => {
  vi.stubGlobal("document", { createElement: (tag: string) => new SidebarElement(tag) });
  const id = "abot-web-generated";
  const fallback = "Explain this failed request";
  const state: ConversationSessionState & { pinnedSessionIds: string[]; busySessionIds: Set<string>; sessionQuery: string } = {
    currentSessionId: "", activeRequestId: "", sessionViewVersion: 0, messages: [], events: [],
    taskProgressByRequest: new Map(), contextWindowByRequest: new Map(), submittedToolApprovalIds: new Set(),
    requestMessages: new Map(), lastSeqByRequest: new Map(), sessions: [{ id, title: fallback }],
    pinnedSessionIds: [], busySessionIds: new Set(), sessionQuery: "",
  };
  const dom = { sessionTitle: { textContent: "" }, sessionsList: new SidebarElement("div") };
  const selectedEnvironmentId = () => "dev";
  const sessions = createSessionController({ state, dom, preferences: {}, selectedEnvironmentId,
    sessionActionsMenu: { reset: vi.fn() }, renderGroups: () => true });
  const snapshot = { title: id, messages: [], requests: [], nextCursor: "older", newerCursor: "newer" };
  const client = {
    loadSession: vi.fn(async (): Promise<Record<string, unknown>> => snapshot),
    listSessions: vi.fn(async () => ({ sessions: state.sessions })),
    fetchRequestEvents: vi.fn(async () => []), markSessionRead: vi.fn(async () => ({ readState: {} })),
  };
  const controller = createConversationSessionController({
    state, dom, client, sessions, selectedEnvironmentId,
    preferences: { sessionIdForEnvironment: () => "", saveSessionIdForEnvironment: vi.fn() },
    sessionQueue: { peek: () => null, rebindBlocked: vi.fn() }, conversationView: { reset: vi.fn() },
    applyConversationChrome: vi.fn(), applyModelSelection: vi.fn(), renderSessions: sessions.render,
    renderMessages: vi.fn(), updateComposerSendState: vi.fn(), setMessageStatus: vi.fn(), sendRealtime: vi.fn(),
    handleRealtimeMessage: vi.fn(), recordEvent: vi.fn(), recordControlEvent: vi.fn(), reportQueueFailure: vi.fn(),
    drainQueuedMessage: vi.fn(), suspendQueueRecovery: () => true, recoverBlockedQueue: vi.fn(),
    isCurrentComposerScope: () => true, scheduleTask: vi.fn(),
  });
  const expectTitle = (title: string) => {
    expect(state.sessions[0]?.title).toBe(title);
    expect(sessions.titleOf(state.sessions[0])).toBe(title);
    expect(dom.sessionTitle.textContent).toBe(title);
  };
  await controller.openSession(id);
  expectTitle(fallback);
  await controller.openSession(id);
  expectTitle(fallback);
  client.loadSession.mockResolvedValueOnce({ ...snapshot, nextCursor: null });
  await controller.history.load("older");
  expectTitle(fallback);
  await controller.history.latest();
  expectTitle(fallback);
  const realtime = createRealtimeEventController({
    state, shell: { showToast: vi.fn() }, selectedEnvironmentId, handleSteerAcknowledgement: () => false,
    shouldAcceptMessage: controller.shouldAcceptRealtimeMessage, applySessionReadState: vi.fn(),
    activeAssistantForRequest: controller.activeAssistantForRequest, addOrMergeMessage: controller.addOrMergeMessage,
    normalizeChatMessage: controller.normalizeMessage, renderMessages: vi.fn(), scheduleMessageRender: vi.fn(),
    scheduleThinkingRender: vi.fn(), cancelScheduledMessageRender: vi.fn(), cancelScheduledThinkingRender: vi.fn(),
    markCurrentSessionReadSoon: vi.fn(), applySessionTitleUpdate: (sessionId, title) => controller.applySessionTitleUpdate(String(sessionId), title),
    setMessageActivityStatus: vi.fn(), updateComposerSendState: vi.fn(), drainQueuedComposerMessage: vi.fn(), loadSessions: vi.fn(),
  });
  realtime.handle({ type: "event", name: "session.title.updated", sessionId: id, environment: "dev", title: "Failure explained" });
  expectTitle("Failure explained");
  await controller.openSession(id);
  expectTitle("Failure explained");
  expect(snapshot.title).toBe(id);
});
