import { describe, expect, test, vi } from "vitest";

import {
  createConversationSessionController,
  normalizeConversationMessage,
} from "../../web-ui/app/controllers/conversation-session-controller.js";

function createHarness() {
  const state = {
    currentSessionId: "",
    activeRequestId: "",
    sessionViewVersion: 0,
    messages: [] as Array<Record<string, any>>,
    events: [] as Array<Record<string, any>>,
    taskProgressByRequest: new Map(),
    contextWindowByRequest: new Map(),
    submittedToolApprovalIds: new Set<string>(),
    requestMessages: new Map<string, string>(),
    lastSeqByRequest: new Map<string, number>(),
  };
  const client = {
    markSessionRead: vi.fn(async () => ({ readState: {} })),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    loadSession: vi.fn(async () => ({
      title: "Loaded session",
      readState: { unreadCount: 0 },
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          text: "stored answer",
          requestId: "request-stored",
          attachments: [{ id: "attachment-1" }],
        },
      ],
      requests: [
        {
          requestId: "request-active",
          status: "streaming",
          events: [
            {
              type: "event",
              name: "tool.started",
              requestId: "request-active",
              seqNo: 1,
            },
          ],
        },
      ],
    })),
    fetchRequestEvents: vi.fn(async () => [
      {
        type: "event",
        name: "tool.completed",
        requestId: "request-active",
        seqNo: 3,
      },
      {
        type: "event",
        name: "thinking.delta",
        requestId: "request-active",
        seqNo: 2,
      },
      {
        type: "event",
        name: "ignored",
        requestId: "request-other",
        seqNo: 1,
      },
    ]),
  };
  const sessions = {
    titleOf: vi.fn(() => "Saved session"),
    byId: vi.fn(() => ({ id: "session-1" })),
    setCurrentTitle: vi.fn(),
    applyTitle: vi.fn(),
    applyReadState: vi.fn(),
  };
  const sessionQueue = {
    rebindBlocked: vi.fn(),
    peek: vi.fn(() => null),
  };
  const conversationView = { reset: vi.fn() };
  const sendRealtime = vi.fn(() => true);
  const handleRealtimeMessage = vi.fn();
  const dependencies = {
    state,
    dom: {
      sessionTitle: { textContent: "" },
      sessionsList: { innerHTML: "" },
    },
    client,
    preferences: {
      sessionIdForEnvironment: vi.fn(() => ""),
      saveSessionIdForEnvironment: vi.fn(),
    },
    sessions,
    sessionQueue,
    conversationView,
    selectedEnvironmentId: () => "dev",
    clearPendingAttachments: vi.fn(),
    applyConversationChrome: vi.fn(),
    applyModelSelection: vi.fn(),
    renderSessions: vi.fn(),
    renderMessages: vi.fn(),
    updateComposerSendState: vi.fn(),
    setMessageStatus: vi.fn(),
    sendRealtime,
    handleRealtimeMessage,
    recordEvent: vi.fn(),
    recordControlEvent: vi.fn(),
    reportQueueFailure: vi.fn(),
    drainQueuedMessage: vi.fn(),
    suspendQueueRecovery: vi.fn(() => true),
    recoverBlockedQueue: vi.fn(),
    isCurrentComposerScope: vi.fn(() => true),
    scheduleTask: vi.fn(),
    createSessionId: () => "session-created",
  };
  return {
    state,
    client,
    sessions,
    sessionQueue,
    sendRealtime,
    handleRealtimeMessage,
    dependencies,
    controller: createConversationSessionController(dependencies as never),
  };
}

describe("web ui conversation session controller", () => {
  test("hydrates one session, replays ordered active events, and resumes it", async () => {
    const harness = createHarness();
    const stateIdentity = harness.state;

    await harness.controller.openSession("session-1");

    expect(harness.state).toBe(stateIdentity);
    expect(harness.state.currentSessionId).toBe("session-1");
    expect(harness.state.activeRequestId).toBe("request-active");
    expect(harness.state.messages).toEqual([
      expect.objectContaining({
        id: "msg-1",
        text: "stored answer",
        attachments: [{ id: "attachment-1" }],
      }),
      expect.objectContaining({
        id: "assistant-request-active",
        requestId: "request-active",
        streaming: true,
      }),
    ]);
    expect(harness.sessions.applyTitle).toHaveBeenCalledWith(
      "session-1",
      "Loaded session",
    );
    expect(harness.sessionQueue.rebindBlocked).toHaveBeenCalledWith(
      { environmentId: "dev", sessionId: "session-1" },
      "request-active",
    );
    expect(
      harness.handleRealtimeMessage.mock.calls.map(([event]) => event.seqNo),
    ).toEqual([1, 2, 3]);
    expect(harness.sendRealtime.mock.calls.map(([message]) => message)).toEqual(
      [
        {
          type: "subscribe_session",
          sessionId: "session-1",
          environment: "dev",
        },
        { type: "subscribe_request", requestId: "request-active" },
        {
          type: "resume_request",
          requestId: "request-active",
          afterSeq: 0,
          environment: "dev",
        },
      ],
    );
  });

  test("normalizes nested messages and merges one assistant per request", () => {
    expect(
      normalizeConversationMessage(
        {
          message: {
            role: "assistant",
            content: "answer",
            requestId: "request-1",
            events: ["tool.started", ""],
          },
        },
        4,
      ),
    ).toMatchObject({
      id: "local-5",
      role: "assistant",
      text: "answer",
      requestId: "request-1",
      events: ["tool.started"],
    });

    const harness = createHarness();
    harness.controller.addOrMergeMessage({
      id: "assistant-request-1",
      role: "assistant",
      requestId: "request-1",
      text: "first",
    });
    harness.controller.addOrMergeMessage({
      id: "server-message-1",
      role: "assistant",
      requestId: "request-1",
      text: "",
      thinkingText: "reasoning",
    });
    expect(harness.state.messages).toHaveLength(1);
    expect(harness.state.messages[0]).toMatchObject({
      id: "server-message-1",
      text: "first",
      thinkingText: "reasoning",
    });
  });
});
