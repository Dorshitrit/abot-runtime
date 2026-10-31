import { describe, expect, test, vi } from "vitest";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";
import { projectUserInteractionEvent, isUserInteractionMessage } from "../../web-ui/app/lib/user-interaction-event.js";
import { applyUserInteractionEvent } from "../../web-ui/app/lib/request-interaction-messages.js";
import { createConversationReadStateController } from "../../web-ui/app/controllers/conversation-read-state-controller.js";
import { projectApprovalContinuations, sameConversationMessage } from "../../web-ui/app/lib/request-lifecycle-view.js";
// @ts-expect-error Browser-only history projection.
import { mergeHistoryPage } from "../../web-ui/app/lib/history-page-messages.js";
// @ts-expect-error Browser-only stopped response projection.
import { restoreStoppedResponses } from "../../web-ui/app/lib/request-stop-state.js";

type Event = Record<string, unknown>;
function event(sequence = 1, overrides: Event = {}): Event {
  return {
    type: "event", name: "user.interaction", requestId: "request-1",
    sessionId: "session-1", environment: "dev", generation: "generation-1",
    eventSequence: sequence + 2,
    interaction: {
      version: 1, interactionId: "request-1:interaction:" + sequence,
      requestId: "request-1", sequence, createdAt: "2026-10-27T12:00:00.000Z",
      kind: "message", payload: { text: "Update " + sequence },
      origin: { callId: "root-1", activationCount: sequence, steeringVersion: 0 },
    },
    ...overrides,
  };
}
function changedInteraction(changes: Event): Event {
  const original = event();
  return event(1, { interaction: { ...original.interaction as Event, ...changes } });
}

describe("user interaction conversation projection", () => {
  test("publishes separate updates, continues the request, and retains the exact final response", () => {
    const f = createPlanLifecycleHarness();
    const finalId = f.state.requestMessages.get("request-1");
    f.realtime.handle(event(1));
    f.realtime.handle(event(2));
    expect(f.state.activeRequestId).toBe("request-1");
    expect(f.state.requestMessages.get("request-1")).toBe(finalId);
    expect(f.drainQueuedComposerMessage).not.toHaveBeenCalled();
    expect(f.markCurrentSessionReadSoon).not.toHaveBeenCalled();
    expect(f.state.messages.map((message) => message.text)).toEqual([
      "Prepare release", "Update 1", "Update 2", "",
    ]);
    f.realtime.handle({ type: "event", name: "tool.started", requestId: "request-1", tool: "read", eventSequence: 6 });
    f.realtime.handle({ type: "completed", requestId: "request-1", output: "  Final\nanswer  ", eventSequence: 7 });
    expect(f.state.messages.map((message) => message.text)).toEqual([
      "Prepare release", "Update 1", "Update 2", "  Final\nanswer  ",
    ]);
    expect(f.state.events.map((record) => record.eventName)).toEqual(["tool.started"]);
    expect(f.drainQueuedComposerMessage).toHaveBeenCalledOnce();
  });

  test.each(["completed", "streaming", "awaiting_approval"])("hydrates updates from saved %s requests and deduplicates reconnect", async (status) => {
    const lifecycle = { schemaVersion: 1, requestId: "request-1", generation: "generation-1", revision: 1, status };
    const f = createPlanLifecycleHarness({
      sessionId: "session-1",
      messages: [
        { id: "user", role: "user", content: "Prepare release", requestId: "request-1" },
        { id: "answer", role: "assistant", content: "Saved answer", requestId: "request-1" },
      ],
      requests: [{
        requestId: "request-1", status, lifecycle,
        events: [{ ...event(1), seqNo: 3 }, { ...event(2), seqNo: 4 }],
        finalState: status === "completed" ? { status, output: "Saved answer" } : undefined,
      }],
    });
    await f.conversationSession.openSession("session-1");
    f.realtime.handle({ ...event(1), eventSequence: 20, seqNo: 20 });
    expect(f.state.messages.filter(isUserInteractionMessage).map((message) => message.text)).toEqual(["Update 1", "Update 2"]);
    expect(f.state.messages.at(-1)?.text).toBe("Saved answer");
    expect(f.state.requestMessages.get("request-1")).toBe("answer");
    expect(f.state.lastSeqByRequest.get("request-1")).toBe(20);
  });

  test("orders late updates by their canonical sequence and does not rewrite an accepted identity", () => {
    const f = createPlanLifecycleHarness();
    f.realtime.handle(event(3));
    f.realtime.handle(event(1));
    f.realtime.handle(event(2));
    f.realtime.handle(changedInteraction({ payload: { text: "Replacement" } }));
    expect(f.state.messages.filter(isUserInteractionMessage).map((message) => message.text)).toEqual([
      "Update 1", "Update 2", "Update 3",
    ]);
    expect(f.state.events).toHaveLength(0);
  });

  test.each(["request_cancelled", "tool_execution_failed"])("does not overwrite updates on %s", (error) => {
    const f = createPlanLifecycleHarness();
    f.realtime.handle(event());
    f.realtime.handle({ type: "failed", requestId: "request-1", error });
    expect(f.state.messages.filter(isUserInteractionMessage).map((message) => message.text)).toEqual(["Update 1"]);
    expect(f.state.messages.at(-1)?.text).toBe(error === "request_cancelled" ? "Response stopped." : error);
  });

  test("keeps updates separate from approval waits, resumed answers, and optimistic message merging", () => {
    const f = createPlanLifecycleHarness();
    f.realtime.handle(event());
    const lifecycle = { schemaVersion: 1, requestId: "request-1", generation: "generation-1", revision: 1, status: "awaiting_approval" };
    f.realtime.handle({
      type: "event", name: "request.lifecycle.changed", requestId: "request-1", lifecycle,
      message: { id: "approval", role: "assistant", kind: "tool_approval_request", content: "Approve tool", requestId: "request-1" },
    });
    f.realtime.handle({
      type: "event", name: "request.lifecycle.changed", requestId: "request-1",
      lifecycle: { ...lifecycle, revision: 2, status: "streaming" },
    });
    f.realtime.handle(event(2));
    f.realtime.handle({ type: "completed", requestId: "request-1", output: "Finished" });
    const visible = projectApprovalContinuations(f.state.messages);
    expect(visible.filter(isUserInteractionMessage)).toHaveLength(2);
    expect(visible.at(-1)?.text).toBe("Finished");
    const update = f.state.messages.find(isUserInteractionMessage)!;
    expect(sameConversationMessage(update, { role: "assistant", requestId: "request-1", text: "Final" })).toBe(false);
  });

  test("history paging cannot bind an interaction as the final response", () => {
    const f = createPlanLifecycleHarness();
    f.realtime.handle(event());
    const update = f.state.messages.find(isUserInteractionMessage)!;
    const saved = { id: "saved", persistedMessageId: "saved", role: "assistant", text: "Saved", requestId: "request-1" };
    mergeHistoryPage(f.state, [saved], "newer", f.state.messages[0]);
    expect(f.state.messages).toContain(update);
    expect(f.state.messages.map((message) => message.text)).toEqual(["Prepare release", "Update 1", "Saved"]);
    expect(f.state.requestMessages.get("request-1")).toBe("saved");
    expect(f.conversationSession.activeAssistantForRequest("request-1").text).toBe("Saved");
  });

  test("an update alone is not a stopped response or a persisted read boundary", () => {
    const update = projectUserInteractionEvent(event())!;
    const messages = [update];
    restoreStoppedResponses(messages, [{ requestId: "request-1", status: "failed", finalState: { error: "request_cancelled" } }]);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.text).toBe("Update 1");
    expect(messages[1]?.text).toBe("Response stopped.");
    const scheduleTask = vi.fn();
    const read = createConversationReadStateController({
      state: { currentSessionId: "session-1", sessionViewVersion: 0, messages: [update] },
      client: { markSessionRead: vi.fn() }, selectedEnvironmentId: () => "dev",
      applyReadState: vi.fn(), recordControlEvent: vi.fn(), scheduleTask,
    });
    read.markCurrentSessionReadSoon();
    expect(scheduleTask).not.toHaveBeenCalled();
  });

  test("rejects foreign session, environment, request binding, and stale generation", () => {
    const f = createPlanLifecycleHarness();
    f.state.requestLifecycles = new Map([["request-1", { generation: "generation-1" }]]);
    for (const incoming of [
      event(1, { sessionId: "another" }), event(1, { environment: "prod" }),
      event(1, { generation: "old" }), changedInteraction({ requestId: "another" }),
    ]) expect(applyUserInteractionEvent(f.state, incoming, "dev")).toBe(false);
    f.realtime.handle(event(1, { environment: "prod", seqNo: 100 }));
    f.realtime.handle(event(1, { generation: "old", seqNo: 200 }));
    expect(f.state.lastSeqByRequest.has("request-1")).toBe(false);
    expect(f.state.messages).toHaveLength(2);
  });

  test.each([
    { version: 2 }, { kind: "question" }, { sequence: 0 }, { interactionId: "" },
    { payload: { text: "" } }, { payload: { text: "x".repeat(1_201) } },
    { payload: { text: { content: "not text" } } }, { createdAt: "invalid" },
    { origin: { callId: "", activationCount: 1, steeringVersion: 0 } },
  ])("ignores malformed or unsupported interaction %j", (change) => {
    const f = createPlanLifecycleHarness();
    f.realtime.handle(changedInteraction(change));
    expect(f.state.messages).toHaveLength(2);
    expect(f.state.events).toHaveLength(0);
  });

  test("ordinary messages keep the existing response and activity behavior", () => {
    const f = createPlanLifecycleHarness();
    f.realtime.handle({ type: "event", name: "thinking.delta", requestId: "request-1", text: "Reasoning" });
    f.realtime.handle({ type: "completed", requestId: "request-1", output: "Normal answer" });
    expect(f.state.messages.filter(isUserInteractionMessage)).toHaveLength(0);
    expect(f.state.messages.at(-1)).toMatchObject({ text: "Normal answer", thinkingText: "Reasoning" });
  });
});
