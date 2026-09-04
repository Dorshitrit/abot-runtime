import { describe, expect, test, vi } from "vitest";

import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

function planEvent(sequence: number, payload: Record<string, unknown>) {
  return {
    type: "event",
    name: "Planner update",
    requestId: "request-1",
    sessionId: "session-1",
    seqNo: sequence,
    eventSequence: sequence,
    stage: "development_plan",
    phase: "updated",
    ...payload,
  };
}

function releasePlanEvents() {
  return [
    planEvent(1, {
      plan: {
        summary: "Previous plan",
        total: 2,
        completed: 2,
        items: [
          { id: "old-draft", title: "Write release", status: "done", order: 1 },
          {
            id: "old-check",
            title: "Check old build",
            status: "done",
            order: 2,
          },
        ],
      },
    }),
    planEvent(2, {
      plan: {
        summary: "Prepare release",
        total: 2,
        completed: 0,
        items: [
          { id: "write", title: "Write release", status: "pending", order: 2 },
          {
            id: "verify",
            title: "Verify release",
            status: "pending",
            order: 1,
          },
        ],
      },
    }),
    planEvent(3, {
      item: { id: "write", title: "Write release", status: "done", order: 2 },
      planSummary: "Prepare release",
      planTotal: 2,
      planCompleted: 1,
    }),
    planEvent(4, {
      item: {
        id: "verify",
        title: "Verify release",
        status: "blocked",
        order: 1,
      },
      planSummary: "Prepare release",
      planTotal: 2,
      planCompleted: 1,
    }),
  ];
}

function persistedPlanEvent(event: ReturnType<typeof planEvent>) {
  const { type, name, requestId, sessionId, seqNo, eventSequence, ...payload } =
    event;
  return { type, name, requestId, sessionId, seqNo, eventSequence, payload };
}

function applyReleasePlan(
  harness: ReturnType<typeof createPlanLifecycleHarness>,
) {
  for (const event of releasePlanEvents()) harness.realtime.handle(event);
}

function deferredPlanReplay() {
  let resolve!: (events: unknown[]) => void;
  const promise = new Promise<unknown[]>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("web ui plan lifecycle", () => {
  test("replaces the live plan and presents canonical progress in the drawer and Activity", () => {
    const harness = createPlanLifecycleHarness();
    const [previous, replacement, completedItem, blockedItem] =
      releasePlanEvents();
    harness.realtime.handle(previous);
    expect(harness.plan()).toMatchObject({ completed: 2, total: 2 });

    harness.realtime.handle(replacement);
    expect(harness.plan()).toMatchObject({
      requestId: "request-1",
      completed: 0,
      total: 2,
      items: [
        { id: "verify", status: "pending" },
        { id: "write", status: "pending" },
      ],
    });

    harness.realtime.handle(completedItem);
    harness.realtime.handle(blockedItem);
    expect(harness.plan()).toMatchObject({
      summary: "Prepare release",
      completed: 1,
      total: 2,
      previewStatus: "pending",
      items: [
        { id: "verify", status: "blocked" },
        { id: "write", status: "done" },
      ],
    });
    const activity = buildConversationActivityModel({
      requestId: "request-1",
      taskProgress: harness.state.taskProgressByRequest.get("request-1"),
    });
    expect(activity.progress).toMatchObject({
      summary: harness.plan()?.summary,
      total: harness.plan()?.total,
      completed: harness.plan()?.completed,
    });
  });

  test("restores the same plan from out-of-order persisted payloads after reload", async () => {
    const live = createPlanLifecycleHarness();
    applyReleasePlan(live);
    live.realtime.handle({
      type: "completed",
      requestId: "request-1",
      output: "Done",
    });
    const restored = createPlanLifecycleHarness({
      messages: live.state.messages,
      requests: [
        {
          requestId: "request-1",
          status: "completed",
          events: releasePlanEvents().reverse().map(persistedPlanEvent),
        },
      ],
    });

    await restored.conversationSession.openSession("session-1");

    expect(restored.plan()).toEqual(live.plan());
    expect(restored.state.activeRequestId).toBe("");
    expect(restored.state.lastSeqByRequest.get("request-1")).toBe(4);
    expect(restored.client.fetchRequestEvents).not.toHaveBeenCalled();
    expect(
      buildConversationActivityModel({
        requestId: "request-1",
        taskProgress: restored.state.taskProgressByRequest.get("request-1"),
      }).progress,
    ).toMatchObject({ completed: 1, total: 2 });
  });

  test("replays only the active request in sequence before resuming its subscription", async () => {
    const live = createPlanLifecycleHarness();
    applyReleasePlan(live);
    const [first, ...remaining] = releasePlanEvents();
    const restored = createPlanLifecycleHarness(
      {
        messages: live.state.messages,
        requests: [
          {
            requestId: "request-1",
            status: "streaming",
            events: [persistedPlanEvent(first)],
          },
        ],
      },
      [
        ...remaining.reverse().map(persistedPlanEvent),
        { ...persistedPlanEvent(first), requestId: "unrelated-request" },
      ],
    );

    await restored.conversationSession.openSession("session-1");

    expect(restored.plan()).toEqual(live.plan());
    expect(restored.client.fetchRequestEvents).toHaveBeenCalledWith({
      requestId: "request-1",
      afterSeq: 1,
      environmentId: "dev",
    });
    expect(restored.sendRealtime).toHaveBeenLastCalledWith({
      type: "resume_request",
      requestId: "request-1",
      afterSeq: 4,
      environment: "dev",
    });
    expect([...restored.state.taskProgressByRequest.keys()]).toEqual([
      "request-1",
    ]);
  });

  test("restores a failed request plan when persisted history contains only its user message", async () => {
    const harness = createPlanLifecycleHarness({
      messages: [
        {
          id: "user-1",
          role: "user",
          text: "Prepare release",
          requestId: "request-1",
        },
      ],
      requests: [
        {
          requestId: "request-1",
          status: "failed",
          events: [
            ...releasePlanEvents().map(persistedPlanEvent),
            {
              type: "failed",
              requestId: "request-1",
              seqNo: 5,
              error: "Verification unavailable",
            },
          ],
        },
      ],
    });

    await harness.conversationSession.openSession("session-1");

    expect(harness.state.messages.map((message) => message.role)).toEqual([
      "user",
    ]);
    expect(harness.state.activeRequestId).toBe("");
    expect(harness.plan()).toMatchObject({
      requestId: "request-1",
      total: 2,
      completed: 1,
      items: [
        { id: "verify", status: "blocked" },
        { id: "write", status: "done" },
      ],
    });
  });

  test.each(["request-1", ""])(
    "retains turn identity after steering an active request with original user requestId %j",
    (requestId) => {
      const harness = createPlanLifecycleHarness();
      harness.state.messages[0].requestId = requestId;
      applyReleasePlan(harness);
      const originalTurnKey = harness.plan()?.turnKey;
      expect(originalTurnKey).toBeTruthy();

      harness.conversationSession.insertSteerMessage({
        steerId: "steer-1",
        requestId: "request-1",
        text: "Keep the report concise",
      });

      expect(harness.state.messages.map((message) => message.id)).toEqual([
        "user-1",
        "steer-steer-1",
        "assistant-1",
      ]);
      expect(harness.plan()?.requestId).toBe("request-1");
      expect(harness.plan()?.turnKey).toBe(originalTurnKey);
    },
  );

  test("reconstructs the complete plan when live progress arrives before the HTTP replay baseline", async () => {
    const live = createPlanLifecycleHarness();
    applyReleasePlan(live);
    const replay = deferredPlanReplay();
    const harness = createPlanLifecycleHarness({
      messages: live.state.messages,
      requests: [{ requestId: "request-1", status: "streaming", events: [] }],
    });
    harness.client.fetchRequestEvents.mockReturnValueOnce(replay.promise);
    const opening = harness.conversationSession.openSession("session-1");
    await vi.waitFor(() =>
      expect(harness.client.fetchRequestEvents).toHaveBeenCalledOnce(),
    );
    expect(harness.sendRealtime).toHaveBeenCalledWith({
      type: "subscribe_request",
      requestId: "request-1",
    });
    expect(harness.client.fetchRequestEvents).toHaveBeenCalledWith({
      requestId: "request-1",
      afterSeq: 0,
      environmentId: "dev",
    });

    harness.realtime.handle(releasePlanEvents()[3]);
    expect(harness.plan()).toMatchObject({
      completed: 1,
      items: [{ id: "verify", status: "blocked" }],
    });
    const replayModels: Array<ReturnType<typeof harness.plan>> = [];
    const renderMessages = harness.renderMessages.getMockImplementation()!;
    harness.renderMessages.mockImplementation(() => {
      renderMessages();
      replayModels.push(harness.plan());
    });
    replay.resolve(releasePlanEvents().slice(1).map(persistedPlanEvent));
    await opening;

    for (const model of replayModels) {
      expect(model?.completed).toBe(1);
      expect(model?.items.find((item) => item.id === "verify")?.status).toBe(
        "blocked",
      );
    }
    expect(harness.plan()).toEqual(live.plan());
    expect(harness.plan()).toMatchObject({
      completed: 1,
      total: 2,
      items: [
        { id: "verify", status: "blocked" },
        { id: "write", status: "done" },
      ],
    });
  });

  test("hides the previous plan from a new user turn until that turn receives its own plan", () => {
    const harness = createPlanLifecycleHarness();
    applyReleasePlan(harness);
    harness.realtime.handle({ type: "completed", requestId: "request-1" });
    expect(harness.plan()).not.toBeNull();

    harness.conversationSession.appendLocalUserMessage({
      text: "Next question",
      attachments: [],
    });
    expect(harness.plan()).toBeNull();
    harness.conversationSession.activateRequestForScope(
      {
        environmentId: "dev",
        sessionId: "session-1",
      },
      "request-2",
    );
    expect(harness.plan()).toBeNull();
    harness.realtime.handle({
      type: "completed",
      requestId: "request-2",
      output: "Answer without a plan",
    });
    expect(harness.plan()).toBeNull();
    expect(harness.state.taskProgressByRequest.has("request-1")).toBe(true);

    harness.conversationSession.clearCurrentSessionView();
    expect(harness.plan()).toBeNull();
    expect(harness.state.taskProgressByRequest.size).toBe(0);
  });

  test.each(["failed", "completed"])(
    "preserves canonical item outcomes when the request is %s",
    (type) => {
      const harness = createPlanLifecycleHarness();
      applyReleasePlan(harness);
      const beforeTerminal = harness.plan();

      harness.realtime.handle({
        type,
        requestId: "request-1",
        error: "Verification unavailable",
      });

      expect(harness.state.activeRequestId).toBe("");
      expect(harness.state.messages.at(-1)?.streaming).toBe(false);
      expect(harness.plan()).toEqual(beforeTerminal);
      expect(harness.plan()?.completed).toBe(1);
      expect(harness.plan()?.previewStatus).not.toBe("done");
    },
  );

  test("rejects live events from unrelated requests and sessions without changing the visible plan", () => {
    const harness = createPlanLifecycleHarness();
    applyReleasePlan(harness);
    const currentPlan = harness.plan();
    const unrelated = planEvent(10, {
      plan: { summary: "Unrelated", items: [] },
    });

    harness.realtime.handle({ ...unrelated, requestId: "request-other" });
    harness.realtime.handle({ ...unrelated, sessionId: "session-other" });
    harness.realtime.handle({ ...unrelated, requestId: "" });

    expect(harness.plan()).toEqual(currentPlan);
    expect([...harness.state.taskProgressByRequest.keys()]).toEqual([
      "request-1",
    ]);
    expect(harness.state.lastSeqByRequest.get("request-1")).toBe(4);
  });
});
