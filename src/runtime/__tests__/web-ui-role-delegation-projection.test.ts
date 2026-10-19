import { describe, expect, test } from "vitest";
import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import { buildConversationRoleCards } from "../../web-ui/app/lib/conversation-role-model.js";
import { projectRoleDelegationEvent } from "../../web-ui/app/lib/role-delegation-event.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

type Event = Record<string, unknown>;

function delegation(overrides: Event = {}): Event {
  return {
    type: "event", name: "role.delegated", requestId: "request-1",
    sessionId: "session-1", generation: "generation-1", eventSequence: 2,
    callerCallId: "call-1", callerRole: "supervisor", childCallId: "call-2",
    childRole: "planner", objective: "Prepare the requested research.",
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

describe("Committed role delegation projection", () => {
  test.each([false, true])("retains exact explicit evidence through live/history ingress (replay=%s)", async (replay) => {
    const objective = "  חקור את המקורות\nKeep the exact canonical objective.  ";
    const { state, model } = await project([
      role("supervisor", "routing", 1),
      delegation({ objective, extraContext: "not presentation data" }),
      role("planner", "planning", 3),
      delegation({ childCallId: "call-3", childRole: "worker", eventSequence: 4 }),
      role("worker", "working", 5),
    ], replay);
    const recorded = state.events.find((event) => event.eventName === "role.delegated")!;
    expect(recorded.roleDelegation).toEqual({
      id: JSON.stringify(["request-1", "generation-1", "call-2"]),
      generation: "generation-1", callerCallId: "call-1", callerRole: "supervisor",
      childCallId: "call-2", childRole: "planner", objective,
    });
    expect(recorded.extraContext).toBeUndefined();
    const supervisor = model.roleCards.find((card) => card.role === "supervisor")!;
    expect(supervisor.delegations?.map((item) => item.childRole)).toEqual(["planner", "worker"]);
    expect(supervisor.summary).toBe("supervisor routing");
    expect(supervisor.active).toBe(false);
    expect(model.roleCards.find((card) => card.role === "worker")?.active).toBe(!replay);
    expect(model.toolCount).toBe(0);
  });

  test.each([false, true])("deduplicates repeated delivery but preserves distinct calls and generations (replay=%s)", async (replay) => {
    const original = delegation();
    const { state, model } = await project([
      original,
      { ...original, seqNo: 25 },
      { ...original, eventSequence: 12 },
      delegation({ childCallId: "call-3" }),
      delegation({ generation: "generation-2" }),
    ], replay);
    expect(state.events).toHaveLength(3);
    expect(model.events).toHaveLength(3);
    expect(model.eventCount).toBe(3);
    const items = model.roleCards[0]!.delegations!;
    expect(items).toHaveLength(3);
    expect(new Set(items.map((item) => item.id)).size).toBe(3);
    expect(items.every((item) => item.objective === original.objective)).toBe(true);
  });

  test("does not merge distinct unsequenced delegations in state or timeline", async () => {
    const { state, model } = await project([
      delegation({ eventSequence: undefined, generation: undefined }),
      delegation({ eventSequence: undefined, generation: undefined, childCallId: "call-3" }),
    ], false);
    expect(state.events).toHaveLength(2);
    expect(model.events).toHaveLength(2);
    expect(model.roleCards[0]!.delegations).toHaveLength(2);
  });

  test("uses original order for late replay and never changes current role", async () => {
    const { model } = await project([
      role("worker", "working", 8),
      delegation({ childCallId: "call-3", eventSequence: 6 }),
      delegation({ eventSequence: 2 }),
    ], false);
    expect(model.roleCards.find((card) => card.role === "supervisor")?.delegations
      ?.map((item) => item.childCallId)).toEqual(["call-2", "call-3"]);
    expect(model.roleCards.filter((card) => card.active).map((card) => card.role)).toEqual(["worker"]);
    expect(model.roleCards.find((card) => card.role === "worker")?.summary).toBe("worker working");
  });

  test("retains existing skills and resumed status alongside delegation history", async () => {
    const { model } = await project([
      { ...role("supervisor", "skills", 1), message: "Read Skills: Research" },
      delegation(),
      { ...role("supervisor", "resuming", 3), message: "Processing The Delegated Result" },
    ], false);
    expect(model.roleCards[0]).toMatchObject({
      title: "Supervisor", summary: "Processing The Delegated Result", active: true,
      skillActivities: [{ summary: "Read Skills: Research", tone: "active" }],
      delegations: [expect.objectContaining({ childRole: "planner" })],
    });
  });

  test("first delegation establishes Supervisor identity without creating an active status", () => {
    const cards = buildConversationRoleCards({
      requestId: "request-1", events: [delegation()], streaming: true,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      title: "Supervisor", summary: "", phaseLabel: "", active: false, tone: "recorded",
    });
  });

  test("terminal requests retain history without active indicators", () => {
    const cards = buildConversationRoleCards({
      requestId: "request-1", streaming: true,
      events: [
        role("worker", "working", 1), delegation(),
        { type: "completed", requestId: "request-1", eventSequence: 3 },
      ],
    });
    expect(cards.every((card) => !card.active)).toBe(true);
    expect(cards.find((card) => card.role === "supervisor")?.delegations).toHaveLength(1);
  });

  test("does not infer old delegations or cross request boundaries", () => {
    const cards = buildConversationRoleCards({
      requestId: "request-1",
      events: [
        role("planner", "planning", 1),
        delegation({ requestId: "request-2" }),
      ],
    });
    expect(cards.map((card) => card.role)).toEqual(["planner"]);
    expect(cards[0]!.delegations).toBeUndefined();
  });

  test.each([
    { callerRole: "planner" }, { childRole: "supervisor" },
    { childRole: "unknown" }, { callerCallId: "" },
    { childCallId: "" }, { requestId: "" }, { objective: " " },
    { objective: "x".repeat(8_193) }, { generation: 1 },
  ])("rejects incomplete or unsupported structured evidence: %j", (overrides) => {
    expect(projectRoleDelegationEvent(delegation(overrides))).toBeNull();
  });

  test("keeps the entire maximum-length objective without coercing unknown metadata", () => {
    const objective = "משימה\n".repeat(1_365).padEnd(8_192, "א");
    expect(projectRoleDelegationEvent(delegation({ objective }))?.objective).toBe(objective);
  });

  test("deduplicates a live event when replay uses a different transport cursor", () => {
    const { realtime, state } = createPlanLifecycleHarness();
    realtime.handle(delegation());
    realtime.handle({ ...delegation(), seqNo: 25 });
    expect(state.events).toHaveLength(1);
    expect(state.lastSeqByRequest.get("request-1")).toBe(25);
  });
});
