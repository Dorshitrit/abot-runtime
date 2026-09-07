import { describe, expect, test } from "vitest";

import { buildEventTimelineEntries } from "../../web-ui/app/lib/event-presentation.js";
import { buildConversationRoleCards } from "../../web-ui/app/lib/conversation-role-model.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

function roleEvent(
  stage: string,
  phase: string,
  eventSequence = 1,
  requestId = "request-1",
) {
  return {
    type: "event",
    name: "Working...",
    requestId,
    sessionId: "session-1",
    eventSequence,
    stage,
    phase,
  };
}

describe("Web UI role event projection", () => {
  test("preserves explicit live role phase and original sequence evidence", () => {
    const { realtime, state } = createPlanLifecycleHarness();
    realtime.handle(roleEvent("worker", "working", 8));

    expect(state.events).toEqual([
      expect.objectContaining({
        requestId: "request-1",
        eventName: "Working...",
        stage: "worker",
        phase: "working",
        eventSequence: 8,
        lastSeqNo: 8,
      }),
    ]);
  });

  test("restores role phases through the real session snapshot path", async () => {
    const replayed = roleEvent("reviewer", "reviewing", 12);
    const harness = createPlanLifecycleHarness({
      sessionId: "session-1",
      messages: [
        {
          id: "answer",
          role: "assistant",
          content: "Saved answer",
          requestId: "request-1",
        },
      ],
      requests: [
        {
          requestId: "request-1",
          status: "completed",
          events: [{ ...replayed, seqNo: 7, timestamp: 1000 }],
          finalState: { status: "completed", output: "Saved answer" },
        },
      ],
    });

    await harness.conversationSession.openSession("session-1");

    expect(harness.state.events).toEqual([
      expect.objectContaining({
        requestId: "request-1",
        stage: "reviewer",
        phase: "reviewing",
        eventSequence: 12,
        lastSeqNo: 7,
      }),
    ]);
    expect(harness.state.activeRequestId).toBe("");
  });

  test("keeps distinct roles, phases and requests separate despite identical display text", () => {
    const { realtime, state } = createPlanLifecycleHarness();
    const events = [
      roleEvent("planner", "working", 1),
      roleEvent("worker", "working", 2),
      roleEvent("worker", "resuming", 3),
      roleEvent("worker", "resuming", 4, "request-2"),
    ];
    for (const event of events) realtime.recordEvent(event);

    expect(state.events).toHaveLength(4);
    expect(buildEventTimelineEntries(state.events)).toHaveLength(4);
    expect(
      state.events.map(({ requestId, stage, phase }) => ({
        requestId,
        stage,
        phase,
      })),
    ).toEqual(
      events.map(({ requestId, stage, phase }) => ({
        requestId,
        stage,
        phase,
      })),
    );
  });

  test("does not collapse a stage into a different event's phase when fields are empty", () => {
    const { realtime, state } = createPlanLifecycleHarness();
    realtime.recordEvent(roleEvent("worker", "", 1));
    realtime.recordEvent(roleEvent("", "worker", 2));

    expect(state.events).toHaveLength(2);
    expect(buildEventTimelineEntries(state.events)).toHaveLength(2);
  });

  test("retains distinct runtime identities while grouping repeated updates only for display", () => {
    const { realtime, state } = createPlanLifecycleHarness();
    realtime.handle(roleEvent("worker", "working", 8));
    realtime.handle(roleEvent("worker", "working", 9));

    expect(state.events).toHaveLength(2);
    expect(state.events[0]).toMatchObject({
      stage: "worker",
      phase: "working",
      count: 1,
      eventSequence: 8,
      lastSeqNo: 8,
    });
    const timeline = buildEventTimelineEntries(state.events);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      count: 2,
      eventSequence: 9,
      lastSeqNo: 9,
    });
  });

  test("retains late role identities before grouping their display", () => {
    const { realtime, state } = createPlanLifecycleHarness();
    realtime.handle(roleEvent("reviewer", "reviewing", 20));
    realtime.handle({ ...roleEvent("reviewer", "reviewing", 12), seqNo: 7 });

    expect(state.events.map((event) => event.eventSequence)).toEqual([20, 12]);
    expect(state.events[0]).toMatchObject({
      stage: "reviewer",
      phase: "reviewing",
      eventSequence: 20,
    });
    const timeline = buildEventTimelineEntries(state.events);
    expect(timeline[0].eventSequence).toBe(20);
  });

  test("deduplicates exact runtime identities within each request", () => {
    const { realtime, state } = createPlanLifecycleHarness();
    realtime.recordEvent(roleEvent("worker", "working", 13));
    realtime.recordEvent({ ...roleEvent("worker", "working", 13), seqNo: 7 });
    realtime.recordEvent(roleEvent("worker", "working", 13, "request-2"));

    expect(
      state.events.map(({ requestId, count }) => ({ requestId, count })),
    ).toEqual([
      { requestId: "request-1", count: 1 },
      { requestId: "request-2", count: 1 },
    ]);
  });

  test.each([undefined, 0, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "keeps legacy coalescing when no positive safe runtime sequence exists: %s",
    (eventSequence) => {
      const { realtime, state } = createPlanLifecycleHarness();
      const message = { ...roleEvent("worker", "working"), eventSequence };
      realtime.recordEvent(message);
      realtime.recordEvent(message);

      expect(state.events).toHaveLength(1);
      expect(state.events[0]).toMatchObject({
        count: 2,
        eventSequence: undefined,
      });
    },
  );

  test("preserves absent role evidence without inferring from a display label", () => {
    const { realtime, state } = createPlanLifecycleHarness();
    realtime.handle({ ...roleEvent("", ""), name: "Worker is working" });

    expect(state.events[0]).toMatchObject({ stage: "", phase: "" });
  });

  test("builds matching live and restored role cards from the full projected handoff", async () => {
    const toolEvent = {
      type: "event",
      requestId: "request-1",
      sessionId: "session-1",
      tool: "read_file",
      message: "Inspect requested files",
    };
    const events = [
      roleEvent("planner", "planning", 1),
      roleEvent("worker", "working", 2),
      { ...toolEvent, name: "tool.started", eventSequence: 3 },
      { ...toolEvent, name: "tool.completed", eventSequence: 4, ok: true },
      roleEvent("reviewer", "reviewing", 5),
      roleEvent("planner", "planning", 6),
      roleEvent("supervisor", "resuming", 7),
    ];
    const live = createPlanLifecycleHarness();
    for (const event of events) live.realtime.handle(event);
    const liveCards = buildConversationRoleCards({
      requestId: "request-1",
      events: live.state.events,
      streaming: true,
    });
    const foreignEvents = [
      roleEvent("worker", "unrelated", 1, "request-2"),
      {
        ...toolEvent,
        requestId: "request-2",
        name: "tool.started",
        eventSequence: 2,
      },
    ];
    const history = createPlanLifecycleHarness({
      sessionId: "session-1",
      messages: [
        {
          id: "answer",
          role: "assistant",
          content: "Saved answer",
          requestId: "request-1",
        },
      ],
      requests: [
        {
          requestId: "request-1",
          status: "completed",
          events: events.map((event, index) => ({
            ...event,
            seqNo: index + 1,
            timestamp: 1000 + index,
          })),
          finalState: { status: "completed", output: "Saved answer" },
        },
        {
          requestId: "request-2",
          status: "completed",
          events: foreignEvents.map((event, index) => ({
            ...event,
            seqNo: index + 1,
            timestamp: 2000 + index,
          })),
          finalState: { status: "completed", output: "Other request" },
        },
      ],
    });
    await history.conversationSession.openSession("session-1");
    const historyCards = buildConversationRoleCards({
      requestId: "request-1",
      events: history.state.events,
      streaming: false,
    });

    expect(
      liveCards.map(({ role, phaseLabel }) => ({ role, phaseLabel })),
    ).toEqual([
      { role: "planner", phaseLabel: "Planning" },
      { role: "worker", phaseLabel: "Working" },
      { role: "reviewer", phaseLabel: "Reviewing" },
      { role: "supervisor", phaseLabel: "Resuming" },
    ]);
    expect(liveCards.find((card) => card.role === "worker")).toMatchObject({
      summary: "file reader | Inspect requested files",
      facts: ["1 read"],
    });
    expect(
      liveCards.filter((card) => card.active).map((card) => card.role),
    ).toEqual(["supervisor"]);
    expect(
      history.state.events.some((event) => event.requestId === "request-2"),
    ).toBe(true);
    expect(historyCards).toEqual(
      liveCards.map((card) => ({ ...card, active: false, tone: "recorded" })),
    );
  });

  test("tracks the replay transport cursor even when original activity is already recorded", () => {
    const { realtime, state } = createPlanLifecycleHarness();
    const message = roleEvent("worker", "working", 13);
    realtime.handle(message);
    realtime.handle({ ...message, seqNo: 21 });

    expect(state.lastSeqByRequest.get("request-1")).toBe(21);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ eventSequence: 13, count: 1 });
  });

  test("keeps late Worker boundaries and duplicate tool replay correct through the role model", () => {
    const { realtime, state } = createPlanLifecycleHarness();
    const tool = {
      type: "event",
      name: "tool.started",
      requestId: "request-1",
      sessionId: "session-1",
      tool: "read_file",
      message: "Earlier Worker read",
      eventSequence: 13,
      seqNo: 9,
    };
    realtime.handle(roleEvent("worker", "working", 20));
    realtime.handle({ ...roleEvent("worker", "working", 12), seqNo: 8 });
    realtime.handle(tool);
    realtime.handle({ ...roleEvent("reviewer", "reviewing", 15), seqNo: 10 });
    realtime.handle(tool);
    const cards = buildConversationRoleCards({
      requestId: "request-1",
      events: state.events,
      streaming: true,
    });

    expect(state.events.map((event) => event.eventSequence)).toEqual([
      20, 12, 13, 15,
    ]);
    expect(cards.find((card) => card.role === "worker")).toMatchObject({
      phaseLabel: "Working",
      facts: ["1 tool call"],
      active: true,
    });
    expect(cards.find((card) => card.role === "reviewer")).toMatchObject({
      phaseLabel: "Reviewing",
      facts: [],
      active: false,
    });
  });
});
