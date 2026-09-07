import { describe, expect, test } from "vitest";
import { createConversationTools } from "../../web-ui/app/components/conversation-tools.js";
import { buildConversationToolActions } from "../../web-ui/app/lib/tool-activity-model.js";
import { buildConversationRoleCards } from "../../web-ui/app/lib/conversation-role-model.js";
import { ContextElement } from "./support/composer-context-window-dom.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

function event(name: string, eventSequence: number, extra = {}) {
  return {
    type: "event",
    name,
    eventSequence,
    requestId: "request-1",
    sessionId: "session-1",
    executionId: "execution-1",
    executorRole: "supervisor",
    roleCallId: "call-1",
    tool: "write_file",
    meta: { path: "notes.txt", inputPreview: "Prepared notes" },
    ...extra,
  };
}

function actions(events: Record<string, unknown>[]) {
  return buildConversationToolActions({ requestId: "request-1", events });
}

function render(events: Record<string, unknown>[]) {
  const documentRoot = {
    createElement: (tag: string) => new ContextElement(tag),
  } as unknown as Document;
  return createConversationTools({ documentRoot }).createNode({
    requestId: "request-1",
    actions: actions(events),
  })!;
}

describe("tool rejection before external execution", () => {
  test("live and restored events settle the prepared action without claiming it was sent", async () => {
    const events = [
      event("tool.payload.started", 1),
      event("tool.payload.completed", 2),
      event("tool.failed", 3, {
        stage: "before_external_execution",
        error: "tool_execution_stale",
      }),
    ];
    const live = createPlanLifecycleHarness();
    events.forEach(live.realtime.handle);
    const restored = createPlanLifecycleHarness({
      sessionId: "session-1",
      messages: [],
      requests: [{ requestId: "request-1", status: "completed", events }],
    });
    await restored.conversationSession.openSession("session-1");
    for (const recorded of [events, live.state.events, restored.state.events]) {
      const result = actions(recorded);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        status: "failed",
        statusLabel: "Failed",
        executed: false,
        executorRole: "supervisor",
        roleCallId: "call-1",
        target: "notes.txt",
        received: [{ label: "Error", value: "tool_execution_stale" }],
      });
      expect(render(recorded).textContent).toContain(
        "Prepared content excerpt",
      );
      expect(render(recorded).textContent).not.toContain(
        "Sent content excerpt",
      );
    }
    expect(actions(restored.state.events)).toEqual(actions(live.state.events));
  });

  test("a Root agent rejection preserves the active Worker in live and restored activity", async () => {
    const events = [
      {
        type: "event",
        name: "runtime.state",
        eventSequence: 1,
        requestId: "request-1",
        sessionId: "session-1",
        stage: "worker",
        phase: "working",
      },
      event("tool.payload.started", 2),
      event("tool.payload.completed", 3),
      event("tool.failed", 4, {
        stage: "before_external_execution",
        error: "tool_execution_stale",
      }),
    ];
    const live = createPlanLifecycleHarness();
    events.forEach(live.realtime.handle);
    const restored = createPlanLifecycleHarness({
      sessionId: "session-1",
      messages: [],
      requests: [{ requestId: "request-1", status: "streaming", events }],
    });
    await restored.conversationSession.openSession("session-1");
    for (const recorded of [events, live.state.events, restored.state.events]) {
      const cards = buildConversationRoleCards({
        requestId: "request-1",
        events: recorded,
        streaming: true,
      });
      expect(
        cards.filter((card) => card.active).map((card) => card.role),
      ).toEqual(["worker"]);
      expect(cards.find((card) => card.role === "worker")).toMatchObject({
        active: true,
        tone: "active",
        toolActions: [],
      });
      expect(cards.find((card) => card.role === "supervisor")).toMatchObject({
        title: "Root agent",
        active: false,
        tone: "failed",
        toolActions: [
          expect.objectContaining({
            executorRole: "supervisor",
            status: "failed",
            executed: false,
          }),
        ],
      });
    }
  });

  test.each([undefined, "external_execution"])(
    "a normal failure with stage %s preserves evidence that execution occurred",
    (stage) => {
      const events = [
        event("tool.failed", 1, { stage, error: "write_failed" }),
      ];
      expect(actions(events)[0]).toMatchObject({
        status: "failed",
        executed: true,
      });
      expect(render(events).textContent).toContain("Sent content excerpt");
    },
  );

  test("a rejection does not erase previously recorded execution evidence", () => {
    const events = [
      event("tool.started", 1),
      event("tool.failed", 2, { stage: "before_external_execution" }),
    ];
    expect(actions(events)[0]).toMatchObject({
      status: "failed",
      executed: true,
    });
  });
});
