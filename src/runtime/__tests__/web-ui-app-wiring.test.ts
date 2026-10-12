import { afterEach, describe, expect, test, vi } from "vitest";

import { createComposerProductionHarness } from "./support/composer-production-harness.js";
afterEach(() => vi.unstubAllGlobals());
import { createSteerController } from "../../web-ui/app/controllers/steer-controller.js";
import { createRealtimeTransport } from "../../web-ui/app/services/realtime-transport.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

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
    const h = createComposerProductionHarness();
    h.enqueue("queued");
    h.enqueue("remaining");
    const bind = vi.spyOn(h.sessionQueue, "bindReleasedSuccess");
    await h.queue.drain({ environmentId: "dev", sessionId: "existing-chat", terminalRequestId: "existing-request" });
    expect(h.client.postChatMessage).toHaveBeenCalledOnce();
    expect(bind).toHaveBeenCalledWith({ environmentId: "dev", sessionId: "existing-chat" }, expect.any(String), "new-request");
    expect(h.session.appendLocalUserMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "queued" }));
    expect(h.session.activateRequestForScope).toHaveBeenCalledWith({ environmentId: "dev", sessionId: "existing-chat" }, "new-request");
    expect(h.sessionQueue.list(h.queue.currentScope())[0].waitForRequestId).toBe("new-request");
  });

  test("an unconfirmed queued start keeps its payload paused without retry or mixing into input", async () => {
    const h = createComposerProductionHarness();
    h.enqueue("queued");
    h.client.postChatMessage.mockRejectedValueOnce(new Error("offline"));
    const terminal = { environmentId: "dev", sessionId: "existing-chat", terminalRequestId: "existing-request" };
    await h.queue.drain(terminal);
    await h.queue.drain(terminal);
    expect(h.client.postChatMessage).toHaveBeenCalledOnce();
    expect(h.dom.composerInput.value).toBe("Existing chat draft");
    const paused = h.composer.lifecycle.paused(h.queue.currentScope());
    expect(paused).toHaveLength(1);
    expect(paused[0].payload.text).toBe("queued");
    expect(paused[0].payload.attachments[0].id).toBe("chat-file");
    expect(h.sessionQueue.getBlockedRelease(h.queue.currentScope())).toBeTruthy();
  });

  test("composer dispatch chooses one action and owns its captured payload through acknowledgement", async () => {
    const h = createComposerProductionHarness();
    h.composerActions.primaryAction.mockReturnValue("send_next");
    h.type("run next");
    const sending = h.composer.submit.dispatch();
    expect(h.composer.lifecycle.hasPendingScope(h.queue.currentScope())).toBe(true);
    expect(h.dom.composerInput.value).toBe("");
    expect(h.workspace.chatDraft().attachments).toEqual([]);
    expect(await sending).toMatchObject({ status: "accepted" });
    expect(h.sessionQueue.list(h.queue.currentScope())).toEqual([expect.objectContaining({ text: "run next", attachments: [expect.objectContaining({ id: "chat-file" })] })]);
    expect(h.client.postChatMessage).not.toHaveBeenCalled();
    expect(h.steer).not.toHaveBeenCalled();
    expect(h.composer.lifecycle.hasPendingScope(h.queue.currentScope())).toBe(false);
    expect(h.dom.composerInput.focus).toHaveBeenCalledOnce();
  });

  test("navigation acknowledges a recovered draft without clearing its parked files", async () => {
    const h = createComposerProductionHarness();
    h.enqueue("recovered");
    h.workspace.chatDraft().take();
    await h.queue.drain({ environmentId: "dev", sessionId: "existing-chat", terminalRequestId: "existing-request", cancelled: true });
    expect(h.workspace.chatDraft().release).toBeTruthy();
    h.type("edited recovered draft");
    expect(await h.queue.suspendRecoveryForNavigation()).toBe(true);
    const release = h.sessionQueue.getBlockedRelease(h.queue.currentScope());
    expect(release?.item.text).toBe("edited recovered draft");
    expect(release?.item.attachments[0].id).toBe("chat-file");
    expect(h.workspace.chatDraft().attachments[0].id).toBe("chat-file");
    expect(h.client.deleteAttachment).not.toHaveBeenCalled();
  });
});
