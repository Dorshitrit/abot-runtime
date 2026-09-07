import { describe, expect, test } from "vitest";
import { projectToolActivityEvent } from "../../web-ui/app/lib/tool-activity-event.js";
import { buildConversationToolActions } from "../../web-ui/app/lib/tool-activity-model.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

function event(
  name: string,
  eventSequence: number,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "event",
    name,
    eventSequence,
    requestId: "request-1",
    sessionId: "session-1",
    executionId: "execution-1",
    executorRole: "worker",
    tool: "edit_file",
    meta: { path: "notes.txt" },
    ...extra,
  };
}

function payload(name: string, sequence: number, stage: number, count = 2) {
  return event(`tool.payload.${name}`, sequence, {
    payloadStage: stage,
    payloadStageCount: count,
  });
}

function preparation() {
  return [
    payload("started", 1, 1),
    payload("completed", 2, 1),
    payload("started", 3, 2),
    payload("completed", 4, 2),
  ];
}

function actions(events: Record<string, unknown>[], streaming = true) {
  return buildConversationToolActions({
    requestId: "request-1",
    events,
    streaming,
  });
}

describe("payload stage projection", () => {
  test("retains the exact top-level stage pair", () => {
    expect(projectToolActivityEvent(payload("started", 1, 2))).toMatchObject({
      payloadStage: 2,
      payloadStageCount: 2,
    });
  });

  test.each([
    [undefined, 2],
    [1, undefined],
    [0, 2],
    [-1, 2],
    [1.5, 2],
    [1, 0],
    [3, 2],
    [1, 2.5],
    ["1", 2],
    [1, "2"],
    [1, Number.MAX_SAFE_INTEGER + 1],
    [Infinity, Infinity],
  ])("rejects an invalid stage pair %s/%s", (payloadStage, payloadStageCount) => {
    const projected = projectToolActivityEvent(
      event("tool.payload.started", 1, { payloadStage, payloadStageCount }),
    );
    expect(projected).not.toHaveProperty("payloadStage");
    expect(projected).not.toHaveProperty("payloadStageCount");
  });
});

describe("staged preparation status", () => {
  test("every stage starts Preparing before approval and execution in one action", () => {
    const events = [
      ...preparation(),
      event("tool.approval.required", 5),
      event("tool.approval.granted", 6),
      event("tool.started", 7),
      event("tool.completed", 8, { ok: true }),
    ];
    const labels = [
      "Preparing",
      "Ready",
      "Preparing",
      "Ready",
      "Awaiting approval",
      "Approved",
      "Running",
      "Completed",
    ];
    const live = createPlanLifecycleHarness();
    const ids = new Set();
    events.forEach((message, index) => {
      live.realtime.handle(message);
      for (const recorded of [events.slice(0, index + 1), live.state.events]) {
        const result = actions(recorded);
        expect(result).toHaveLength(1);
        expect(result[0]!.statusLabel).toBe(labels[index]);
        expect(result[0]!.executed).toBe(index >= 6);
        ids.add(result[0]!.id);
      }
    });
    expect(ids.size).toBe(1);
  });

  test("an older stage completion cannot finish the next stage", () => {
    const events = [
      ...preparation().slice(0, 3),
      payload("completed", 5, 1),
    ];
    expect(actions(events)[0]).toMatchObject({
      status: "preparing",
      statusLabel: "Preparing",
      executed: false,
    });
  });

  test("a duplicated start cannot reopen its own completed stage", () => {
    const events = [...preparation(), payload("started", 5, 2)];
    expect(actions(events)[0]!.statusLabel).toBe("Ready");
  });

  test("a conflicting stage count cannot mark the current preparation ready", () => {
    const events = [
      ...preparation().slice(0, 3),
      payload("completed", 5, 2, 3),
    ];
    expect(actions(events)[0]!.statusLabel).toBe("Preparing");
  });

  test("out-of-order and overlapping replay retains the newer preparation stage", () => {
    const [firstStart, firstEnd, secondStart] = preparation();
    const expected = actions([firstStart!, firstEnd!, secondStart!]);
    expect(
      actions([secondStart!, firstEnd!, firstStart!, secondStart!]),
    ).toEqual(expected);
    expect(expected[0]!.statusLabel).toBe("Preparing");
  });

  test("a second-stage preparation failure stays terminal without execution evidence", () => {
    const failed = [
      ...preparation().slice(0, 3),
      payload("failed", 4, 2),
      payload("started", 5, 2),
    ];
    expect(actions(failed)[0]).toMatchObject({
      status: "failed",
      statusLabel: "Preparation failed",
      executed: false,
    });
  });

  test.each([
    ["tool.approval.required", "Awaiting approval"],
    ["tool.approval.granted", "Approved"],
    ["tool.started", "Running"],
    ["tool.completed", "Completed"],
    ["tool.failed", "Failed"],
    ["tool.approval.rejected", "Not approved"],
  ])("a later payload stage cannot reopen %s", (name, statusLabel) => {
    const events = [
      payload("started", 1, 1),
      payload("completed", 2, 1),
      event(name, 3, { ok: true }),
      payload("started", 4, 2),
    ];
    expect(actions(events)[0]!.statusLabel).toBe(statusLabel);
  });

  test("missing stage metadata preserves the previous monotonic phase behavior", () => {
    const events = [
      event("tool.payload.started", 1),
      event("tool.payload.completed", 2),
      event("tool.payload.started", 3),
    ];
    expect(actions(events)[0]!.statusLabel).toBe("Ready");
    expect(actions(events, false)[0]!.statusLabel).toBe(
      "Completion not recorded",
    );
  });

  test.each([false, true])(
    "live and restored stages agree when completed=%s",
    async (completed) => {
      const events = preparation().slice(0, completed ? 4 : 3);
      if (completed) {
        events.push(
          event("tool.started", 5),
          event("tool.completed", 6, { ok: true }),
        );
      }
      const live = createPlanLifecycleHarness();
      events.forEach(live.realtime.handle);
      const restored = createPlanLifecycleHarness({
        sessionId: "session-1",
        messages: [],
        requests: [{
          requestId: "request-1",
          status: completed ? "completed" : "streaming",
          events: [...events].reverse(),
        }],
      });
      await restored.conversationSession.openSession("session-1");
      restored.realtime.handle(events.at(-1)!);
      const expected = actions(events, !completed);
      expect(actions(live.state.events, !completed)).toEqual(expected);
      expect(actions(restored.state.events, !completed)).toEqual(expected);
      expect(expected[0]!.statusLabel).toBe(completed ? "Completed" : "Preparing");
    },
  );
});

describe("saved memory identifier", () => {
  test("the saved ID is both the compact target and a recorded result field", () => {
    const [action] = actions([
      event("tool.completed", 1, {
        tool: "memory_add",
        ok: true,
        meta: { savedId: "mem-0007" },
      }),
    ]);
    expect(action!.target).toBe("mem-0007");
    expect(action!.received).toContainEqual({
      label: "Saved memory ID",
      value: "mem-0007",
    });
  });

  test("saved ID remains the last fallback after an explicit target", () => {
    const [action] = actions([
      event("tool.completed", 1, {
        tool: "memory_add",
        ok: true,
        meta: { id: "requested-id", savedId: "mem-0007" },
      }),
    ]);
    expect(action!.target).toBe("requested-id");
  });
});
