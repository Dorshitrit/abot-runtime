import { describe, expect, test } from "vitest";
// @ts-expect-error Browser-only component has no declaration surface.
import { createConversationStatus } from "../../web-ui/app/components/conversation-status.js";
import { createComposerContextDom } from "./support/composer-context-window-dom.js";
import {
  compactionEvent,
  contextSnapshotEvent,
  createScopedContextHarness,
} from "./support/context-evidence-fixture.js";

function statusHarness() {
  const h = createScopedContextHarness();
  const dom = createComposerContextDom();
  let connected = true;
  const status = createConversationStatus({
    getActiveRequestId: () => h.state.activeRequestId,
    getActivityForMessage: () => ({
      contextWindow: h.current(),
      events: h.state.events,
    }),
    isConnected: () => connected,
    documentRoot: dom.documentRoot,
  });
  const node = status.createNode(h.assistant);
  dom.container.appendChild(node);
  return {
    ...h,
    ...dom,
    status,
    node,
    setConnected: (value: boolean) => {
      connected = value;
    },
  };
}

describe("context status accessibility acceptance", () => {
  test.each(["completed", "failed"])(
    "B13 %s updates the same accessible status node with no utility fallback",
    (phase) => {
      const h = statusHarness();
      h.send(compactionEvent("started", 10));
      h.send(
        contextSnapshotEvent({
          eventSequence: 11,
          modelStep: "context.compact",
          contextWindowTokens: null,
        }),
      );
      h.status.render();
      expect(h.node.textContent).toBe("Compacting context");
      expect(h.node.getAttribute("role")).toBe("status");
      expect(h.node.getAttribute("aria-live")).toBe("polite");
      expect(h.node.getAttribute("aria-atomic")).toBe("true");
      h.send(compactionEvent(phase, 12));
      h.status.render();
      expect(h.node.textContent).toBe("Working");
      expect(h.container.children).toEqual([h.node]);
    },
  );

  test.each([false, true])(
    "B14 tool completion retires a model label only on a comparable transport clock (originalSnapshot=%s)",
    (originalSnapshot) => {
      const h = statusHarness();
      h.send(
        contextSnapshotEvent({
          eventSequence: originalSnapshot ? 10 : undefined,
          ...(originalSnapshot ? {} : { seqNo: 10 }),
        }),
      );
      h.status.render();
      expect(h.node.textContent).toBe("Making a decision");
      h.send({
        type: "event",
        name: "tool.completed",
        requestId: "request-1",
        seqNo: 20,
        tool: "write_file",
        executionId: "execution-1",
      });
      h.status.render();
      expect(h.node.textContent).toBe(
        originalSnapshot ? "Making a decision" : "Working",
      );
    },
  );

  test("B7/B10 retained or foreign generation tool terminals cannot retire the current model step", () => {
    const h = statusHarness();
    h.send({
      type: "event",
      name: "tool.completed",
      requestId: "request-1",
      eventSequence: 20,
      tool: "write_file",
      executionId: "old-tool",
    });
    h.send({
      type: "event",
      name: "request.lifecycle.changed",
      requestId: "request-1",
      generation: "generation-2",
      lifecycle: {
        schemaVersion: 1,
        requestId: "request-1",
        generation: "generation-2",
        revision: 1,
        status: "streaming",
      },
    });
    h.send(
      contextSnapshotEvent({ eventSequence: 10, generation: "generation-2" }),
    );
    h.status.render();
    expect(h.node.textContent).toBe("Making a decision");
    h.send({
      type: "event",
      name: "tool.completed",
      requestId: "request-1",
      eventSequence: 21,
      tool: "write_file",
      executionId: "foreign-tool",
    });
    h.status.render();
    expect(h.node.textContent).toBe("Making a decision");
    h.send({
      type: "event",
      name: "tool.completed",
      requestId: "request-1",
      generation: "generation-2",
      eventSequence: 22,
      tool: "write_file",
      executionId: "current-tool",
    });
    h.status.render();
    expect(h.node.textContent).toBe("Working");
  });

  test("B14 disconnect, approval and running-tool priorities stay above compaction; cancellation never revives work", () => {
    const h = statusHarness();
    h.send(compactionEvent("started", 10));
    h.status.render();
    expect(h.node.textContent).toBe("Compacting context");
    h.setConnected(false);
    h.status.render();
    expect(h.node.textContent).toBe("Reconnecting");
    expect(h.node.classList.contains("is-animated")).toBe(false);
    h.setConnected(true);
    h.send({
      type: "event",
      name: "tool.approval.required",
      requestId: "request-1",
      eventSequence: 11,
      tool: "write_file",
      executionId: "execution-1",
    });
    h.status.render();
    expect(h.node.textContent).toBe("Waiting for approval");
    expect(h.node.classList.contains("is-animated")).toBe(false);
    h.send({
      type: "event",
      name: "tool.started",
      requestId: "request-1",
      eventSequence: 12,
      tool: "write_file",
      executionId: "execution-1",
    });
    h.status.render();
    expect(h.node.textContent).toBe("Running tool");
    h.send({
      type: "failed",
      requestId: "request-1",
      eventSequence: 20,
      error: "request_cancelled",
    });
    h.status.render();
    expect(h.node.hidden).toBe(true);
    expect(h.node.textContent).toBe("");
    expect(h.node.classList.contains("is-animated")).toBe(false);
    h.send(compactionEvent("completed", 19));
    h.status.render();
    expect(h.node.hidden).toBe(true);
    expect(h.node.textContent).toBe("");
  });
});
