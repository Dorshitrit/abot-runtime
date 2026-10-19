import { describe, expect, test } from "vitest";
import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import { buildConversationRoleCards } from "../../web-ui/app/lib/conversation-role-model.js";
import { projectRoleReturnEvent } from "../../web-ui/app/lib/role-return-event.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

type Event = Record<string, unknown>;

function receipt(overrides: Event = {}): Event {
  return {
    type: "event", name: "role.returned", requestId: "request-1",
    sessionId: "session-1", generation: "generation-1", eventSequence: 4,
    callerCallId: "call-1", callerRole: "supervisor", childCallId: "call-2",
    childRole: "planner", outcome: "completed", summary: "Prepared the requested plan.",
    ...overrides,
  };
}

function role(stage: string, phase: string, eventSequence: number): Event {
  return {
    type: "event", name: "runtime.state", requestId: "request-1",
    sessionId: "session-1", stage, phase, eventSequence,
    message: `${stage} ${phase}`,
  };
}

async function project(events: Event[], replay: boolean) {
  const before = JSON.stringify(events);
  const snapshot = {
    sessionId: "session-1",
    messages: [{ id: "answer", role: "assistant", content: "Saved answer", requestId: "request-1" }],
    requests: [{
      requestId: "request-1", status: "completed",
      events: events.map((event, index) => ({ ...event, seqNo: index + 1 })),
      finalState: { status: "completed", output: "Saved answer" },
    }],
  };
  const harness = createPlanLifecycleHarness(replay ? snapshot : {});
  if (replay) await harness.conversationSession.openSession("session-1");
  else for (const event of events) harness.realtime.handle(event);
  expect(JSON.stringify(events)).toBe(before);
  return {
    ...harness,
    model: buildConversationActivityModel({
      requestId: "request-1", events: harness.state.events, streaming: !replay,
    }),
  };
}

describe("Canonical Planner return projection", () => {
  test.each([false, true])("keeps exact uncapped result through normalized live/history ingress (replay=%s)", async (replay) => {
    const summary = "  תוצאת התכנון\n<literal>& evidence  ".repeat(500);
    const source = receipt({ summary, extraContext: "not presentation data" });
    const { type, name, requestId, sessionId, eventSequence, ...payload } = source;
    const { state, model } = await project([
      role("planner", "planning", 2),
      { type, name, requestId, sessionId, eventSequence, payload },
      role("supervisor", "resuming", 5),
    ], replay);
    const stored = state.events.find((event) => event.eventName === "role.returned")!;
    expect(summary.length).toBeGreaterThan(8_192);
    expect(stored.roleReturn).toEqual({
      id: JSON.stringify(["request-1", "generation-1", "call-2"]),
      generation: "generation-1", callerCallId: "call-1", callerRole: "supervisor",
      childCallId: "call-2", childRole: "planner", outcome: "completed", summary,
    });
    expect(stored.summary).toBe(summary);
    expect(stored.extraContext).toBeUndefined();
    expect(model.roleCards.find((card) => card.role === "planner")).toMatchObject({
      summary: "", returns: [expect.objectContaining({ summary })], active: false,
    });
    expect(model.roleCards.find((card) => card.role === "supervisor")?.active).toBe(!replay);
    expect(model.progress).toBeNull();
    expect(model.toolCount).toBe(0);
  });

  test.each([false, true])("deduplicates receipts independently of delegations, calls, and generations (replay=%s)", async (replay) => {
    const original = receipt();
    const { state, model } = await project([
      { ...original, name: "role.delegated", objective: "Prepare the requested plan." },
      original, { ...original, seqNo: 25 }, { ...original, eventSequence: 12 },
      receipt({ childCallId: "call-3" }),
      receipt({ generation: "generation-2" }),
    ], replay);
    expect(state.events).toHaveLength(4);
    expect(model.events).toHaveLength(4);
    const returns = model.roleCards.find((card) => card.role === "planner")!.returns!;
    expect(returns).toHaveLength(3);
    expect(new Set(returns.map((item) => item.id)).size).toBe(3);
    expect(returns.every((item) => item.summary === original.summary)).toBe(true);
    expect(model.roleCards.find((card) => card.role === "supervisor")?.delegations).toHaveLength(1);
  });

  test("keeps distinct unsequenced same-text returns separate in state and timeline", async () => {
    const { state, model } = await project([
      receipt({ eventSequence: undefined, generation: undefined }),
      receipt({ eventSequence: undefined, generation: undefined, childCallId: "call-3" }),
    ], false);
    expect(state.events).toHaveLength(2);
    expect(model.events).toHaveLength(2);
    expect(model.roleCards[0]!.returns).toHaveLength(2);
  });

  test.each(["completed", "failed"])("suppresses stale planning without changing active role or request failure (%s)", async (outcome) => {
    const { state, model } = await project([
      role("planner", "planning", 2), receipt({ outcome }),
    ], false);
    expect(model.roleCards[0]).toMatchObject({
      role: "planner", summary: "", active: true, tone: "active",
      returns: [expect.objectContaining({ outcome })],
    });
    expect(model.failureCount).toBe(0);
    expect(state.activeRequestId).toBe("request-1");
    expect(state.messages.find((message) => message.role === "assistant")).toMatchObject({
      text: "", streaming: true,
    });
  });

  test("uses original order for late returns and shows a newer real planning status", async () => {
    const { model } = await project([
      role("planner", "planning", 8),
      receipt({ outcome: "failed", eventSequence: 4 }),
      role("planner", "planning", 2),
      receipt({ childCallId: "call-3", eventSequence: 6 }),
    ], false);
    const planner = model.roleCards[0]!;
    expect(planner.summary).toBe("planner planning");
    expect(planner.active).toBe(true);
    expect(planner.returns?.map((item) => item.childCallId)).toEqual(["call-2", "call-3"]);
  });

  test("uses replay cursor order when original sequences are unavailable", () => {
    const cards = buildConversationRoleCards({
      requestId: "request-1",
      events: [
        { ...receipt(), eventSequence: undefined, seqNo: 5 },
        { ...role("planner", "planning", 2), eventSequence: undefined, seqNo: 2 },
      ],
    });
    expect(cards[0]!.summary).toBe("");
    expect(cards[0]!.returns).toHaveLength(1);
  });

  test("first receipt creates only historical Planner content", () => {
    const cards = buildConversationRoleCards({
      requestId: "request-1", events: [receipt({ outcome: "failed" })], streaming: true,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      title: "Planner", summary: "", phaseLabel: "", active: false, tone: "recorded",
    });
  });

  test("retains real activity failure and terminal state independently of receipt outcome", () => {
    const cards = buildConversationRoleCards({
      requestId: "request-1", streaming: true,
      events: [
        { ...role("planner", "planning", 2), status: "failed" },
        receipt(),
        { type: "completed", requestId: "request-1", eventSequence: 6 },
      ],
    });
    expect(cards[0]).toMatchObject({ tone: "failed", active: false, summary: "" });
  });

  test("does not infer returns from legacy plans, statuses, or another request", () => {
    const cards = buildConversationRoleCards({
      requestId: "request-1",
      events: [
        role("planner", "planning", 2),
        { type: "event", name: "planner.plan.created", requestId: "request-1",
          plan: { summary: "Request-level plan without role-call ownership" } },
        receipt({ requestId: "request-2" }),
      ],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.summary).toBe("planner planning");
    expect(cards[0]!.returns).toBeUndefined();
  });

  test("replayed receipt cannot clear newer planning after an approval continuation", async () => {
    const saved = receipt({ seqNo: 4 });
    const lifecycle = {
      schemaVersion: 1, requestId: "request-1", generation: "generation-1",
      revision: 1, status: "awaiting_approval",
    };
    const { realtime, state, conversationSession } = createPlanLifecycleHarness({
      sessionId: "session-1",
      messages: [{
        id: "approval", role: "assistant", kind: "tool_approval_request",
        content: "Approve the delegated tool", requestId: "request-1",
      }],
      requests: [{
        requestId: "request-1", status: "awaiting_approval", lifecycle,
        events: [{ ...role("planner", "planning", 2), seqNo: 2 }, saved],
      }],
    });
    await conversationSession.openSession("session-1");
    expect(state.activeRequestId).toBe("");
    realtime.handle({
      type: "event", name: "request.lifecycle.changed", requestId: "request-1",
      sessionId: "session-1", eventSequence: 6,
      lifecycle: { ...lifecycle, revision: 2, status: "streaming" },
    });
    expect(state.activeRequestId).toBe("request-1");
    realtime.handle(role("planner", "planning", 8));
    realtime.handle({ ...saved, eventSequence: 15, seqNo: 25 });
    const cards = buildConversationRoleCards({
      requestId: "request-1", events: state.events, streaming: true,
    });
    expect(cards[0]!.summary).toBe("planner planning");
    expect(cards[0]!.returns).toHaveLength(1);
    expect(state.lastSeqByRequest.get("request-1")).toBe(25);
  });

  test("return payload cannot assign stage or alter current role", async () => {
    const { model } = await project([
      role("worker", "working", 2),
      receipt({ stage: "planner", phase: "planning", outcome: "failed" }),
    ], false);
    expect(model.roleCards.filter((card) => card.active).map((card) => card.role)).toEqual(["worker"]);
    expect(model.roleCards.find((card) => card.role === "worker")?.summary).toBe("worker working");
  });

  test.each([
    { callerRole: "planner" }, { childRole: "worker" }, { childRole: "supervisor" },
    { callerCallId: "" }, { childCallId: "" }, { requestId: "" },
    { outcome: "pending" }, { summary: " " }, { summary: { text: "coerced" } },
    { generation: 1 },
  ])("rejects incomplete or unsupported return evidence: %j", (overrides) => {
    expect(projectRoleReturnEvent(receipt(overrides))).toBeNull();
  });
});
