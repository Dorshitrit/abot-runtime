import { describe, expect, test } from "vitest";

// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createConversationStatus } from "../../web-ui/app/components/conversation-status.js";
import { createComposerContextDom } from "./support/composer-context-window-dom.js";

function createStatusHarness() {
  const dom = createComposerContextDom();
  const message = {
    id: "assistant-1",
    requestId: "request-1",
    role: "assistant",
    streaming: true,
  };
  const state = {
    activeRequestId: message.requestId,
    connected: true,
    contextWindow: {
      requestId: message.requestId,
      snapshot: {
        requestId: message.requestId,
        modelStep: "worker.decision",
        admissionOutcome: "accepted",
        invocationId: "invocation-1",
      },
    },
    events: [] as Record<string, unknown>[],
  };
  const status = createConversationStatus({
    getActiveRequestId: () => state.activeRequestId,
    getActivityForMessage: () => ({
      contextWindow: state.contextWindow,
      events: state.events,
    }),
    isConnected: () => state.connected,
    documentRoot: dom.documentRoot,
  });
  return { ...dom, message, state, status };
}

describe("conversation activity text", () => {
  test("updates the same live node from context while preserving its animation phase", () => {
    const { status, state, message, container } = createStatusHarness();
    const node = status.createNode(message);
    container.appendChild(node);
    const animationDelay = node.style.getPropertyValue(
      "--status-shimmer-delay",
    );
    expect(node.textContent).toBe("Making a decision");
    expect(node.classList.contains("is-animated")).toBe(true);

    state.contextWindow.snapshot.modelStep = "supervisor.response";
    status.render();
    expect(container.children).toEqual([node]);
    expect(node.textContent).toBe("Preparing response");
    expect(node.style.getPropertyValue("--status-shimmer-delay")).toBe(
      animationDelay,
    );
    expect(node.getAttribute("role")).toBe("status");
    expect(node.getAttribute("aria-live")).toBe("polite");
    expect(node.getAttribute("dir")).toBe("ltr");
    expect(node.getAttribute("lang")).toBe("en");
  });

  test("stops shimmer for disconnection and approval, then resumes on progress", () => {
    const { status, state, message } = createStatusHarness();
    const node = status.createNode(message);
    state.connected = false;
    status.render();
    expect(node.textContent).toBe("Reconnecting");
    expect(node.classList.contains("is-animated")).toBe(false);

    state.connected = true;
    state.events.push({
      requestId: message.requestId,
      name: "tool.approval.required",
      tool: "write_file",
      executionId: "execution-1",
      eventSequence: 3,
    });
    status.render();
    expect(node.textContent).toBe("Waiting for approval");
    expect(node.classList.contains("is-animated")).toBe(false);

    state.events.push({
      requestId: message.requestId,
      name: "tool.started",
      tool: "write_file",
      executionId: "execution-1",
      eventSequence: 4,
    });
    status.render();
    expect(node.textContent).toBe("Running tool");
    expect(node.classList.contains("is-animated")).toBe(true);
  });

  test("removes live text on completion and keeps history, user rows, and other requests inactive", () => {
    const { status, state, message } = createStatusHarness();
    const node = status.createNode(message);
    message.streaming = false;
    status.render();
    expect(node.hidden).toBe(true);
    expect(node.textContent).toBe("");
    expect(node.classList.contains("is-animated")).toBe(false);
    expect(status.createNode(message)).toBeNull();
    expect(
      status.createNode({ ...message, streaming: true, role: "user" }),
    ).toBeNull();
    expect(
      status.createNode({ ...message, streaming: true, requestId: "old" }),
    ).toBeNull();

    message.streaming = true;
    state.activeRequestId = "request-2";
    status.render();
    expect(node.hidden).toBe(true);
    status.reset();
    state.activeRequestId = message.requestId;
    status.render();
    expect(node.hidden).toBe(true);
  });
});
