import { describe, expect, test } from "vitest";
import { isFilePayloadToolRequest as isRuntimeHandoff } from "../events/file-payload-handoff.js";
import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import { createConversationTools } from "../../web-ui/app/components/conversation-tools.js";
import { isFilePayloadToolRequest } from "../../web-ui/app/lib/file-payload-handoff.js";
import { eventTone, formatEventDetail, formatEventLabel, isUncompletedToolEvent } from "../../web-ui/app/lib/event-presentation.js";
import { projectToolActivityEvent } from "../../web-ui/app/lib/tool-activity-event.js";
import { ContextElement } from "./support/composer-context-window-dom.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

const code = "payload_author_tool_requested";
const label = "Requested a tool before writing";

function event(name: string, eventSequence: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "event", name, eventSequence, requestId: "request-1", sessionId: "session-1",
    executionId: "write-deferred", executorRole: "supervisor", presentationRole: "execution_agent",
    tool: "edit_text", meta: { path: "app.js" }, ...extra,
  };
}

function handoff(name = "tool.payload.failed", eventSequence = 2) {
  return event(name, eventSequence, {
    error: code, ...(name === "tool.failed" ? { stage: "before_external_execution" } : {}),
    status: "Edit file: payload failed", message: "Payload generation failed",
    meta: { path: "app.js", errorCode: code },
  });
}

function cached(message: Record<string, unknown>) {
  return {
    type: "event", requestId: message.requestId, eventSequence: message.eventSequence,
    eventName: message.name, name: "Tool not prepared", summary: `Payload generation failed | error=${code}`,
    tone: "failed", toolActivity: projectToolActivityEvent(message),
  };
}

function model(events: Record<string, unknown>[], requestId = "request-1", streaming = false) {
  return buildConversationActivityModel({ requestId, events, streaming });
}

function render(events: Record<string, unknown>[]) {
  const documentRoot = {
    createElement: (tag: string) => Object.assign(new ContextElement(tag), { open: false, title: "" }),
  } as unknown as Document;
  const renderer = createConversationTools({ documentRoot });
  return renderer.createNode({ requestId: "request-1", actions: model(events).toolActions })!;
}

function savedSession(events: Record<string, unknown>[]) {
  return {
    sessionId: "session-1",
    messages: [{ id: "answer", role: "assistant", content: "Saved", requestId: "request-1" }],
    requests: [{ requestId: "request-1", status: "completed", events,
      finalState: { status: "completed", output: "Saved" } }],
  };
}

function successfulLifecycle() {
  return [
    event("tool.payload.started", 1), handoff(), handoff("tool.failed", 3),
    event("tool.started", 4, { executionId: "dependency-read", tool: "read_text", meta: { path: "dependency.js" } }),
    event("tool.completed", 5, { executionId: "dependency-read", tool: "read_text", ok: true,
      meta: { path: "dependency.js", outputPreview: "export const dependency = 1;" } }),
    event("tool.payload.started", 6, { executionId: "write-resumed" }),
    event("tool.payload.completed", 7, { executionId: "write-resumed" }),
    event("tool.started", 8, { executionId: "write-resumed" }),
    event("tool.completed", 9, { executionId: "write-resumed", ok: true,
      meta: { path: "app.js", state: "refine_target", outputPreview: "Updated app" } }),
  ];
}

describe("file author capability handoff presentation", () => {
  test.each([
    { name: "tool.payload.failed", error: code, expected: true },
    { name: "tool.failed", error: code, stage: "before_external_execution", expected: true },
    { name: "tool.failed", error: code, expected: false },
    { name: "tool.failed", error: code, stage: "after_external_execution", expected: false },
    { name: "tool.failed", error: code, stage: "after_external_execution", beforeExternalExecution: true, expected: false },
    { name: "tool.completed", error: code, ok: false, expected: false },
    { name: "tool.payload.failed", error: "payload_author_declined", expected: false },
    { name: "tool.payload.failed", error: "unknown_failure", expected: false },
  ])("browser and runtime agree on $name/$error/$stage", ({ expected, ...shape }) => {
    expect(isFilePayloadToolRequest(shape)).toBe(expected);
    expect(isRuntimeHandoff(shape)).toBe(expected);
    const raw = event(shape.name, 1, shape);
    expect(isFilePayloadToolRequest(projectToolActivityEvent(raw))).toBe(expected);
    expect(isFilePayloadToolRequest(cached(raw))).toBe(expected);
  });

  test.each(["tool.payload.failed", "tool.failed"])("%s stays neutral in raw and old cached activity", (name) => {
    const raw = handoff(name);
    const projected = projectToolActivityEvent(raw)!;
    expect(projected.error).toBe(code);
    for (const message of [raw, cached(raw)]) {
      const before = JSON.stringify(message);
      expect(formatEventLabel(message)).toBe(label);
      expect(formatEventDetail(message)).toBe("");
      expect(eventTone(message)).toBe("neutral");
      expect(isUncompletedToolEvent(message)).toBe(false);
      const result = model([message]);
      expect(result.failureCount).toBe(0);
      expect(result.events[0]).toMatchObject({ name: label, summary: "", tone: "neutral" });
      expect(result.toolActions).toHaveLength(1);
      expect(result.toolActions[0]).toMatchObject({ status: "tool_requested", statusLabel: label, executed: false });
      expect(result.toolActions[0]!.received).not.toContainEqual(expect.objectContaining({ label: "Error" }));
      expect(result.toolActions[0]!.fileReference).toBeUndefined();
      const node = render([message]);
      expect(node.querySelector(".is-tool_requested")).not.toBeNull();
      expect(node.querySelector(".is-failed")).toBeNull();
      expect(node.querySelector(".conversation-tool-symbol")?.textContent).toBe("↪");
      expect(node.textContent).toContain(label);
      expect(node.textContent).not.toMatch(/payload_author_tool_requested|Payload generation failed/);
      expect(JSON.stringify(message)).toBe(before);
    }
    expect(projected.error).toBe(code);
  });

  test("live and stored lifecycles keep the handoff, selected read and committed write distinct", async () => {
    const events = successfulLifecycle();
    const live = createPlanLifecycleHarness();
    events.slice(0, 3).forEach(live.realtime.handle);
    const waiting = model(live.state.events, "request-1", true);
    expect(waiting.toolActions[0]).toMatchObject({ status: "tool_requested", executed: false });
    events.slice(3).forEach(live.realtime.handle);
    const stored = createPlanLifecycleHarness(savedSession(events));
    await stored.conversationSession.openSession("session-1");
    const liveModel = model(live.state.events);
    const restoredModel = model(stored.state.events);
    expect(restoredModel.toolActions).toEqual(liveModel.toolActions);
    expect(liveModel.toolActions.map(({ status, executed }) => ({ status, executed }))).toEqual([
      { status: "tool_requested", executed: false },
      { status: "completed", executed: true },
      { status: "completed", executed: true },
    ]);
    expect(new Set(liveModel.toolActions.map(({ id }) => id)).size).toBe(3);
    expect(liveModel.failureCount).toBe(0);
    expect(restoredModel.failureCount).toBe(0);
    expect(render(stored.state.events).textContent).toBe(render(live.state.events).textContent);
    expect(live.state.events.filter((entry) => isFilePayloadToolRequest(entry)))
      .toHaveLength(2);
    for (const entry of live.state.events.filter((item) => isFilePayloadToolRequest(item))) {
      expect((entry.toolActivity as { error: string }).error).toBe(code);
    }
  });

  test("a subsequent tool failure and author decline remain failed after a neutral handoff", () => {
    const events = [handoff(), handoff("tool.failed", 3),
      event("tool.failed", 4, { executionId: "dependency-read", tool: "read_text", error: "file_not_found" }),
      event("tool.payload.failed", 5, { executionId: "write-declined", error: "payload_author_declined" }),
    ];
    const result = model(events);
    expect(result.toolActions.map(({ status }) => status)).toEqual(["tool_requested", "failed", "failed"]);
    expect(result.toolActions[1]!.received).toContainEqual({ label: "Error", value: "file_not_found" });
    expect(result.toolActions[2]!.received).toContainEqual({ label: "Error", value: "payload_author_declined" });
    expect(render(events).textContent).toContain("file_not_found");
    expect(render(events).textContent).toContain("payload_author_declined");
  });

  test.each([
    { name: "tool.failed", error: code },
    { name: "tool.failed", error: code, stage: "after_external_execution" },
    { name: "tool.completed", error: code, ok: false },
    { name: "tool.payload.failed", error: "unknown_failure" },
  ])("unrecognized failure $name/$error/$stage keeps its error", (shape) => {
    const raw = event(shape.name, 1, shape);
    for (const message of [raw, cached(raw)]) {
      const action = model([message]).toolActions[0]!;
      expect(action.status).toBe("failed");
      expect(action.received).toContainEqual({ label: "Error", value: shape.error });
      expect(render([message]).querySelector(".is-failed")).not.toBeNull();
    }
  });

  test("request boundaries isolate the same execution id and preserve the other request's failure", () => {
    const events = [cached(handoff()), cached(event("tool.failed", 3, {
      requestId: "request-2", sessionId: "session-2", error: "file_not_found",
    }))];
    expect(model(events).toolActions.map(({ status }) => status)).toEqual(["tool_requested"]);
    expect(model(events, "request-2").toolActions.map(({ status }) => status)).toEqual(["failed"]);
    expect(model(events, "request-3").toolActions).toEqual([]);
  });
});
