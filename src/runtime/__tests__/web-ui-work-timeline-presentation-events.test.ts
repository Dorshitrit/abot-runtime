import { describe, expect, test } from "vitest";
import { projectUserInteractionEvent } from "../../web-ui/app/lib/user-interaction-event.js";
import { buildConversationWorkTimeline } from "../../web-ui/app/lib/conversation-work-timeline-model.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

function acknowledgement(sequence = 3) {
  return { type: "event", name: "thinking.delta", requestId: "request-1", sessionId: "session-1", environment: "dev",
    generation: "generation-1", eventSequence: sequence, seqNo: sequence,
    presentationKind: "acknowledgement", text: "I will inspect this.\n\n", delta: "I will inspect this.\n\n" };
}

describe("ordered user-authored presentation evidence", () => {
  test("retains EA order and a detached exact publication origin", () => {
    const origin = { callId: "root-1", activationCount: 2, steeringVersion: 4 };
    const projected = projectUserInteractionEvent({
      type: "event", name: "user.interaction", requestId: "request-1", generation: "generation-1", eventSequence: 45, seqNo: 71,
      interaction: { version: 1, kind: "message", requestId: "request-1", interactionId: "interaction-2", sequence: 2,
        createdAt: "2026-10-28T10:00:00.000Z", payload: { text: "Update" }, origin },
    });
    expect(projected).toMatchObject({ eventSequence: 45, seqNo: 71, interactionSequence: 2, interactionOrigin: origin });
    expect(projected!.interactionOrigin).not.toBe(origin);
    expect(buildConversationWorkTimeline({ requestId: "request-1", updates: [projected!] })[0])
      .toMatchObject({ kind: "message", role: "root", source: "interaction", origin });
  });

  test("routes tagged acknowledgements to the timeline once without touching reasoning or final text", () => {
    const f = createPlanLifecycleHarness();
    const reasoning = { type: "event", name: "thinking.delta", requestId: "request-1", text: "Private model reasoning", eventSequence: 2 };
    f.realtime.handle(reasoning);
    f.realtime.handle(acknowledgement());
    f.realtime.handle(acknowledgement());
    const assistant = f.state.messages.at(-1)!;
    expect(assistant.thinkingText).toBe("Private model reasoning");
    expect(assistant.text).toBe("");
    const timeline = buildConversationWorkTimeline({ requestId: "request-1", events: f.state.events });
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: "message", source: "acknowledgement", text: acknowledgement().text });
    expect(f.state.lastSeqByRequest.get("request-1")).toBe(3);
    expect(f.state.activeRequestId).toBe("request-1");
  });

  test("record-only history projection retains tagged ack but never generic thinking", () => {
    const f = createPlanLifecycleHarness();
    f.realtime.recordEvent(acknowledgement());
    f.realtime.recordEvent({ type: "event", name: "thinking.delta", requestId: "request-1", text: "Private", eventSequence: 4 });
    expect(f.state.events).toHaveLength(1);
    expect(f.state.events[0]).toMatchObject({ presentationKind: "acknowledgement", text: acknowledgement().text, eventSequence: 3, lastSeqNo: 3 });
  });
  test.each(["streaming", "completed"])("restores %s history with live acknowledgement/reasoning parity", async (status) => {
    const lifecycle = { schemaVersion: 1, requestId: "request-1", generation: "generation-1", revision: 1, status };
    const reasoning = { type: "event", name: "thinking.delta", requestId: "request-1", text: "Exact private reasoning", eventSequence: 2, seqNo: 2 };
    const ack = acknowledgement();
    const f = createPlanLifecycleHarness({
      sessionId: "session-1",
      messages: [
        { id: "user", role: "user", requestId: "request-1", content: "Inspect it" },
        { id: "answer", role: "assistant", requestId: "request-1", content: status === "completed" ? "Exact final answer" : "" },
      ],
      requests: [{ requestId: "request-1", status, lifecycle, events: [reasoning, ack] }],
    });
    await f.conversationSession.openSession("session-1");
    const assistant = f.state.messages.find((message) => message.role === "assistant")!;
    expect(assistant.thinkingText).toBe(reasoning.text);
    expect(assistant.text).not.toContain(ack.text.trim());
    const restored = buildConversationWorkTimeline({ requestId: "request-1", events: f.state.events });
    const live = createPlanLifecycleHarness();
    live.realtime.handle(reasoning);
    live.realtime.handle(ack);
    expect(restored).toEqual(buildConversationWorkTimeline({ requestId: "request-1", events: live.state.events }));
    f.realtime.handle(ack);
    expect(buildConversationWorkTimeline({ requestId: "request-1", events: f.state.events })).toEqual(restored);
  });

  test("rejects foreign or stale acknowledgement scope on direct history projection", () => {
    const f = createPlanLifecycleHarness();
    f.state.requestLifecycles = new Map([["request-1", { generation: "generation-1" }]]);
    for (const fields of [{ sessionId: "another" }, { environment: "prod" }, { generation: "stale" }])
      f.realtime.recordEvent({ ...acknowledgement(), ...fields });
    expect(f.state.events).toEqual([]);
    expect(f.state.lastSeqByRequest.has("request-1")).toBe(false);
  });

  test("keeps distinct unsequenced authored acknowledgements instead of coalescing their text", () => {
    const f = createPlanLifecycleHarness();
    const first = { ...acknowledgement(), eventSequence: undefined, seqNo: undefined, text: "First acknowledgement" };
    const second = { ...first, text: "Second acknowledgement" };
    f.realtime.handle(first);
    f.realtime.handle(second);
    expect(f.state.events).toHaveLength(2);
    expect(buildConversationWorkTimeline({ requestId: "request-1", events: f.state.events })
      .filter((entry) => entry.kind === "message").map((entry) => entry.text))
      .toEqual([first.text, second.text]);
  });

});
