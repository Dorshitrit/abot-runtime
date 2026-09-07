import { describe, expect, test, vi } from "vitest";

import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

import {
  createConversationReadStateController,
  type ConversationReadStateControllerOptions,
} from "../../web-ui/app/controllers/conversation-read-state-controller.js";

function createHarness() {
  let environmentId = "dev";
  let visible = true;
  const tasks: Array<() => void> = [];
  const state: ConversationReadStateControllerOptions["state"] = {
    currentSessionId: "session-1",
    sessionViewVersion: 1,
    messages: [
      { id: "msg-2", role: "assistant", text: "Read me", requestId: "request-1" },
      { id: "msg-9", role: "user", text: "A question", requestId: "request-2" },
    ],
  };
  const readState = { unreadCount: 1, readThroughMessageId: 2 };
  const client = {
    markSessionRead: vi.fn(async () => ({ readState })),
  };
  const applyReadState = vi.fn();
  const recordControlEvent = vi.fn();
  const controller = createConversationReadStateController({
    state,
    client,
    selectedEnvironmentId: () => environmentId,
    applyReadState,
    recordControlEvent,
    isConversationVisible: () => visible,
    scheduleTask: (callback) => tasks.push(callback),
  });
  return {
    state,
    client,
    controller,
    tasks,
    readState,
    applyReadState,
    recordControlEvent,
    setEnvironmentId(value: string) {
      environmentId = value;
    },
    setVisible(value: boolean) {
      visible = value;
    },
    async runTasks() {
      while (tasks.length) tasks.shift()!();
      await Promise.resolve();
    },
  };
}

describe("web ui conversation read visibility", () => {
  test("marks only the persisted assistant boundary captured while Chat is visible", async () => {
    const harness = createHarness();
    harness.controller.markCurrentSessionReadSoon();
    harness.state.messages.push({
      id: "msg-10",
      role: "assistant",
      text: "Arrived after scheduling",
      requestId: "request-2",
    });

    await harness.runTasks();

    expect(harness.client.markSessionRead).toHaveBeenCalledWith({
      environmentId: "dev",
      sessionId: "session-1",
      readThroughMessageId: 2,
    });
    expect(harness.applyReadState).toHaveBeenCalledWith(
      "session-1",
      harness.readState,
    );
  });

  test("acknowledges the exact displayed completed request before its persisted ID is hydrated", async () => {
    const harness = createHarness();
    harness.state.messages.push({
      id: "assistant-request-2",
      role: "assistant",
      text: "Finished answer",
      requestId: "request-2",
      streaming: false,
    });
    harness.controller.markCurrentSessionReadSoon();

    await harness.runTasks();

    expect(harness.client.markSessionRead).toHaveBeenCalledWith({
      environmentId: "dev",
      sessionId: "session-1",
      readThroughMessageId: null,
      readThroughRequestId: "request-2",
    });
  });

  test("does not acknowledge a streaming assistant or fall back to an older boundary", async () => {
    const harness = createHarness();
    harness.state.messages.push({
      id: "assistant-request-2",
      role: "assistant",
      text: "Partial answer",
      requestId: "request-2",
      streaming: true,
    });
    harness.controller.markCurrentSessionReadSoon();

    await harness.runTasks();

    expect(harness.client.markSessionRead).not.toHaveBeenCalled();
  });

  test("does not turn an unbound local error into a read-all acknowledgement", async () => {
    const harness = createHarness();
    harness.state.messages.push({
      id: "error-local",
      role: "assistant",
      text: "Failed before starting a request",
      requestId: "",
      streaming: false,
    });
    harness.controller.markCurrentSessionReadSoon();

    await harness.runTasks();

    expect(harness.client.markSessionRead).not.toHaveBeenCalled();
  });

  test("sends a request read boundary only when the stable message boundary is absent", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) =>
      new Response(JSON.stringify({ readState: { unreadCount: 0 } })),
    );
    const client = createRuntimeWebClient({
      getConfig: () => ({ apiBasePath: "/web-api" }),
      getEnvironmentId: () => "dev",
      fetchImpl,
      origin: "http://localhost:5177",
    });
    await client.markSessionRead({
      sessionId: "session-1",
      readThroughMessageId: null,
      readThroughRequestId: "  request-2  ",
    });
    await client.markSessionRead({
      sessionId: "session-1",
      readThroughMessageId: 8,
      readThroughRequestId: "request-2",
    });

    expect(fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body))))
      .toEqual([
        {
          readThroughMessageId: null,
          lastReadMessageId: null,
          readThroughRequestId: "request-2",
        },
        { readThroughMessageId: 8, lastReadMessageId: "8" },
      ]);
  });

  test("keeps a background Chat unread until the visible workspace returns", async () => {
    const harness = createHarness();
    harness.setVisible(false);
    harness.controller.markCurrentSessionReadSoon();
    await harness.runTasks();

    expect(harness.client.markSessionRead).not.toHaveBeenCalled();
    expect(harness.tasks).toHaveLength(0);

    harness.setVisible(true);
    harness.controller.markCurrentSessionReadSoon();
    await harness.runTasks();

    expect(harness.client.markSessionRead).toHaveBeenCalledOnce();
  });

  test("does not mark messages after the workspace or document becomes hidden", async () => {
    const harness = createHarness();
    harness.controller.markCurrentSessionReadSoon();
    harness.setVisible(false);

    await harness.runTasks();

    expect(harness.client.markSessionRead).not.toHaveBeenCalled();
  });

  test.each(["session", "environment", "view"] as const)(
    "ignores a queued read after the %s scope changes",
    async (scope) => {
      const harness = createHarness();
      harness.controller.markCurrentSessionReadSoon();
      if (scope === "session") harness.state.currentSessionId = "session-2";
      if (scope === "environment") harness.setEnvironmentId("prod");
      if (scope === "view") harness.state.sessionViewVersion += 1;

      await harness.runTasks();

      expect(harness.client.markSessionRead).not.toHaveBeenCalled();
    },
  );

  test("does not apply a delayed read response to another environment", async () => {
    const harness = createHarness();
    let resolveRead!: (value: { readState: typeof harness.readState }) => void;
    harness.client.markSessionRead.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    harness.controller.markCurrentSessionReadSoon();
    await harness.runTasks();

    harness.setEnvironmentId("prod");
    resolveRead({ readState: harness.readState });
    await Promise.resolve();

    expect(harness.applyReadState).not.toHaveBeenCalled();
  });

  test("reports a read failure without mutating the current read state", async () => {
    const harness = createHarness();
    harness.client.markSessionRead.mockRejectedValueOnce(new Error("Offline"));
    harness.controller.markCurrentSessionReadSoon();

    await harness.runTasks();

    expect(harness.applyReadState).not.toHaveBeenCalled();
    expect(harness.recordControlEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Read state update failed",
        summary: "Offline",
      }),
    );
  });

  test("does not create read requests for a new conversation draft", async () => {
    const harness = createHarness();
    harness.state.currentSessionId = "";
    harness.controller.markCurrentSessionReadSoon();

    await harness.runTasks();

    expect(harness.client.markSessionRead).not.toHaveBeenCalled();
  });
});
