import { describe, expect, test, vi } from "vitest";

import { createComposerQueueController } from "../../web-ui/app/controllers/composer-queue-controller.js";
import { createComposerSubmitController } from "../../web-ui/app/controllers/composer-submit-controller.js";
import { createSteerController } from "../../web-ui/app/controllers/steer-controller.js";
import { createRealtimeTransport } from "../../web-ui/app/services/realtime-transport.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

function createQueueHarness(overrides: Record<string, unknown> = {}) {
  type BlockedRelease = {
    releaseToken: string;
    item: {
      text: string;
      attachments: Array<{ id: string }>;
    };
  };
  const state = {
    currentSessionId: "session-1",
    activeRequestId: "request-1",
    agentMode: "reasoning",
    pendingAttachments: [{ id: "attachment-1" }],
    composerQueueDrainingScopes: new Set<string>(),
    composerQueueRecoveredReleaseTokens: new Set<string>(),
    activeComposerQueueRecovery: null as null | Record<string, unknown>,
    messages: [] as Array<Record<string, unknown>>,
  };
  const queue = {
    list: vi.fn(() => []),
    enqueue: vi.fn(),
    releaseForTerminal: vi.fn(() => ({
      item: {
        text: "queued",
        attachments: [{ id: "queued-file" }],
        agentMode: "reasoning",
        toolPermissionMode: "full_access",
        modelPreference: { profileId: "model-1" },
      },
      releaseToken: "release-1",
    })),
    bindReleasedSuccess: vi.fn(() => true),
    getBlockedRelease: vi.fn<() => BlockedRelease | null>(() => null),
    updateBlockedRelease: vi.fn(() => true),
  };
  const attachments = {
    invalidateCompletions: vi.fn(),
    render: vi.fn(),
    clear: vi.fn(),
  };
  const dependencies = {
    state,
    dom: { composerInput: { value: "draft" } },
    queue,
    selectedEnvironmentId: () => "dev",
    getToolPermissionMode: () => "full_access",
    getModelPreference: () => ({ profileId: "model-1" }),
    rememberModelSelection: vi.fn(),
    attachments,
    updateSendState: vi.fn(),
    postChatMessage: vi.fn(async () => "request-2"),
    appendLocalUserMessage: vi.fn(),
    activateRequestForScope: vi.fn(),
    renderMessages: vi.fn(),
    setMessageStatus: vi.fn(),
    recordControlEvent: vi.fn(),
    resizeComposer: vi.fn(),
    ...overrides,
  };
  return {
    state,
    queue,
    attachments,
    dependencies,
    controller: createComposerQueueController(dependencies as never),
  };
}

describe("web ui application collaborators", () => {
  test("runtime client owns semantic endpoint construction, payloads, attachments, and errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ mode: "deep" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "denied" }), { status: 403 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ attachment: { id: "attachment-1" } }), {
          status: 200,
        }),
      );
    const client = createRuntimeWebClient({
      getConfig: () => ({
        apiBasePath: "/custom-api",
        agentModePath: "/mode",
      }),
      getEnvironmentId: () => "dev",
      fetchImpl,
      origin: "http://localhost:5177",
    });

    await expect(client.setAgentMode("deep", "dev")).resolves.toEqual({
      mode: "deep",
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/mode?environment=dev",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      mode: "deep",
      environment: "dev",
    });

    await expect(client.getSystemHealth()).rejects.toThrow("denied");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("/web-health");

    const attachmentInput = {
      environmentId: "dev profile",
      sessionId: "session/1",
      storageRef: "session/1/file.png",
      id: "attachment/1",
      mimeType: "image/png",
    };
    expect(client.attachmentPreviewUrl(attachmentInput)).toBe(
      "/custom-api/chat/attachments?environment=dev+profile&sessionId=session%2F1&storageRef=session%2F1%2Ffile.png&id=attachment%2F1&mimeType=image%2Fpng",
    );
    await client.deleteAttachment(attachmentInput);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("/custom-api/chat/attachments?"),
      { method: "DELETE" },
    );

    const file = new Blob(["hello"], { type: "text/plain" });
    await expect(
      client.uploadAttachment({
        environmentId: "dev profile",
        sessionId: "session/1",
        name: "notes.txt",
        mimeType: "text/plain",
        file,
      }),
    ).resolves.toEqual({ id: "attachment-1" });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      "/custom-api/chat/attachments?environment=dev+profile&sessionId=session%2F1&name=notes.txt",
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: file,
      },
    );
  });

  test("runtime client owns chat, replay, read-state, and bootstrap contracts", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ apiBasePath: "/custom-api" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ readState: { unreadCount: 0 } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ requestId: "request-2" }), {
          status: 200,
        }),
      );
    const client = createRuntimeWebClient({
      getConfig: () => ({ apiBasePath: "/custom-api" }),
      getEnvironmentId: () => "dev profile",
      fetchImpl,
      origin: "http://localhost:5177",
    });

    await expect(client.loadWebConfig()).resolves.toEqual({
      apiBasePath: "/custom-api",
    });
    await client.markSessionRead({
      sessionId: "session/1",
      readThroughMessageId: 14.8,
    });
    await expect(
      client.fetchRequestEvents({ requestId: "request/1", afterSeq: 9 }),
    ).resolves.toEqual([]);
    await expect(
      client.postChatMessage({
        text: "hello",
        attachments: [{ id: "attachment-1" }],
        sessionId: "session-1",
        agentMode: "reasoning",
        toolPermissionMode: "ask",
        modelPreference: { profileId: "model-1" },
      }),
    ).resolves.toBe("request-2");

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/web-config");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "/custom-api/chat/sessions/session%2F1/read?environment=dev%20profile",
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      readThroughMessageId: 14,
      lastReadMessageId: "14",
    });
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(
      "/custom-api/requests/request%2F1/events?afterSeq=9&environment=dev%20profile",
    );
    expect(fetchImpl.mock.calls[3]?.[0]).toBe("/custom-api/chat/messages");
    expect(JSON.parse(String(fetchImpl.mock.calls[3]?.[1]?.body))).toEqual({
      text: "hello",
      environment: "dev profile",
      sessionId: "session-1",
      agentMode: "reasoning",
      toolPermissionMode: "ask",
      attachments: [{ id: "attachment-1" }],
      modelPreference: { profileId: "model-1" },
    });
  });

  test("realtime transport decodes one frame and delegates parsed messages", async () => {
    class FakeSocket {
      static OPEN = 1;
      static instance: FakeSocket;
      readyState = FakeSocket.OPEN;
      listeners = new Map<string, (event?: { data: unknown }) => void>();
      sent: string[] = [];
      constructor(public readonly url: string) {
        FakeSocket.instance = this;
      }
      addEventListener(
        name: string,
        listener: (event?: { data: unknown }) => void,
      ) {
        this.listeners.set(name, listener);
      }
      send(value: string) {
        this.sent.push(value);
      }
    }
    const onMessage = vi.fn();
    const transport = createRealtimeTransport({
      getConfig: () => ({ realtimePath: "/events" }),
      onMessage,
      onOpen: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
      onParseError: vi.fn(),
      WebSocketImpl: FakeSocket as never,
      location: { protocol: "http:", host: "localhost:5177" } as Location,
      scheduleReconnect: vi.fn() as never,
    });
    transport.connect();
    expect(FakeSocket.instance.url).toBe("ws://localhost:5177/events");
    FakeSocket.instance.listeners.get("message")?.({
      data: JSON.stringify({ type: "completed", requestId: "request-1" }),
    });
    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith({
        type: "completed",
        requestId: "request-1",
      });
    });
    expect(transport.send({ type: "resume_request" })).toBe(true);
    expect(FakeSocket.instance.sent).toEqual([
      JSON.stringify({ type: "resume_request" }),
    ]);
  });

  test("steer resolves only after the matching acknowledgement", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const accepted = vi.fn();
    const controller = createSteerController({
      sendRealtime: (message) => {
        sent.push(message);
        return true;
      },
      getScope: () => ({
        requestId: "request-1",
        environmentId: "dev",
        sessionId: "session-1",
      }),
      getPendingAttachmentCount: () => 0,
      onAccepted: accepted,
      setTimer: (() => 1) as never,
      clearTimer: vi.fn(),
    });
    const steering = controller.steer("continue");
    const steerId = String(sent[0]?.steerId);
    expect(accepted).not.toHaveBeenCalled();
    expect(
      controller.handleAcknowledgement({
        type: "steer_ack",
        requestId: "request-1",
        steerId,
        accepted: true,
      }),
    ).toBe(true);
    await steering;
    expect(accepted).toHaveBeenCalledWith({
      steerId,
      requestId: "request-1",
      text: "continue",
    });
  });

  test("queue drain starts exactly one successor and binds the remaining queue", async () => {
    const harness = createQueueHarness();
    await harness.controller.drain({
      environmentId: "dev",
      sessionId: "session-1",
      terminalRequestId: "request-1",
    });
    expect(harness.queue.releaseForTerminal).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.postChatMessage).toHaveBeenCalledTimes(1);
    expect(harness.queue.bindReleasedSuccess).toHaveBeenCalledWith(
      { environmentId: "dev", sessionId: "session-1" },
      "release-1",
      "request-2",
    );
    expect(harness.dependencies.appendLocalUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "queued", requestId: "request-2" }),
    );
    expect(harness.dependencies.activateRequestForScope).toHaveBeenCalledWith(
      { environmentId: "dev", sessionId: "session-1" },
      "request-2",
    );
  });

  test("failed queued start restores the draft without automatic retry", async () => {
    const postChatMessage = vi.fn(async () => {
      throw new Error("offline");
    });
    const harness = createQueueHarness({ postChatMessage });
    await harness.controller.drain({
      environmentId: "dev",
      sessionId: "session-1",
      terminalRequestId: "request-1",
    });
    expect(postChatMessage).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.dom.composerInput.value).toContain("queued");
    expect(
      harness.state.composerQueueRecoveredReleaseTokens.has("release-1"),
    ).toBe(true);
    expect(harness.queue.bindReleasedSuccess).not.toHaveBeenCalled();
  });

  test("composer dispatch owns one selected action and its busy lifecycle", async () => {
    const state = {
      activeRequestId: "request-1",
      currentSessionId: "session-1",
      pendingAttachments: [] as unknown[],
      composerSending: false,
    };
    const input = {
      value: "run next",
      scrollHeight: 72,
      style: { height: "" },
      focus: vi.fn(),
    };
    const queue = {
      isCurrentDraining: vi.fn(() => false),
      queuedCount: vi.fn(() => 0),
      enqueue: vi.fn(async () => {}),
      restoreText: vi.fn(),
    };
    const composerActions = {
      primaryAction: vi.fn(() => "send_next"),
      render: vi.fn(),
    };
    const setMessageStatus = vi.fn();
    const controller = createComposerSubmitController({
      state,
      dom: { composerInput: input },
      composerActions,
      attachments: { activeUploadCount: vi.fn(() => 0) },
      queue,
      steer: vi.fn(async () => {}),
      chatRequests: { sendMessage: vi.fn(async () => {}) },
      conversationSession: { appendRequestError: vi.fn() },
      selectedEnvironmentId: () => "dev",
      setMessageStatus,
    });

    controller.dispatch();
    expect(state.composerSending).toBe(true);
    expect(input.value).toBe("");
    expect(queue.enqueue).toHaveBeenCalledWith("run next");
    await vi.waitFor(() => expect(state.composerSending).toBe(false));
    expect(setMessageStatus).toHaveBeenCalledWith(
      "Message queued for this conversation.",
      true,
    );
    expect(input.focus).toHaveBeenCalledTimes(1);
  });

  test("navigation persists one recovered draft and preserves its attachments", () => {
    const blocked = {
      releaseToken: "release-1",
      item: { text: "old", attachments: [{ id: "old-file" }] },
    };
    const harness = createQueueHarness();
    harness.queue.getBlockedRelease.mockReturnValue(blocked);
    harness.state.activeComposerQueueRecovery = {
      scope: { environmentId: "dev", sessionId: "session-1" },
      releaseToken: "release-1",
    };
    expect(harness.controller.suspendRecoveryForNavigation()).toBe(true);
    expect(harness.queue.updateBlockedRelease).toHaveBeenCalledWith(
      { environmentId: "dev", sessionId: "session-1" },
      "release-1",
      expect.objectContaining({
        text: "draft",
        attachments: [{ id: "attachment-1" }],
      }),
    );
    expect(harness.attachments.clear).toHaveBeenCalledWith({ cleanup: false });
  });
});
