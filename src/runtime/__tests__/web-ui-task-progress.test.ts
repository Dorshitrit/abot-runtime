import { describe, expect, test } from "vitest";

import {
  reduceTaskProgress,
  type TaskProgress,
  type TaskProgressItem,
} from "../../web-ui/app/lib/task-progress.js";

function planItem(
  id: string,
  status: TaskProgressItem["status"] = "pending",
  order = 1,
  title = id,
): TaskProgressItem {
  return { id, title, status, order };
}

function snapshot(
  items: TaskProgressItem[],
  overrides: Record<string, unknown> = {},
) {
  return {
    type: "event",
    requestId: "request-1",
    stage: "development_plan",
    phase: "updated",
    name: "A display title that is not a machine event name",
    eventSequence: 1,
    plan: {
      summary: "Requested work",
      total: items.length,
      completed: items.filter((item) => item.status === "done").length,
      items,
    },
    ...overrides,
  };
}

function itemUpdate(
  item: TaskProgressItem,
  overrides: Record<string, unknown> = {},
) {
  return {
    type: "event",
    requestId: "request-1",
    stage: "development_plan",
    phase: "updated",
    eventSequence: 2,
    item,
    ...overrides,
  };
}

describe("Web UI canonical task progress", () => {
  test("replaces the whole snapshot, removing items and decreasing completion", () => {
    const current = reduceTaskProgress(
      undefined,
      snapshot([planItem("first", "done"), planItem("removed", "done", 2)]),
    );
    const next = reduceTaskProgress(
      current,
      snapshot([planItem("first", "in_progress")], { eventSequence: 2 }),
    );

    expect(next).toMatchObject({
      requestId: "request-1",
      total: 1,
      completed: 0,
      activeItem: "first",
      hasSignal: true,
      hasSnapshot: true,
      items: [planItem("first", "in_progress")],
    });
    expect(current?.items).toHaveLength(2);
    expect(current?.completed).toBe(2);
  });

  test("preserves authoritative counters even when only some items are present", () => {
    const next = reduceTaskProgress(
      undefined,
      snapshot([], {
        plan: {
          summary: "Full work",
          total: 8,
          completed: 5,
          items: [planItem("shown", "done")],
        },
      }),
    );

    expect(next).toMatchObject({ total: 8, completed: 5 });
    expect(next?.items).toHaveLength(1);
  });

  test("accepts an empty replacement and clears the previous summary", () => {
    const current = reduceTaskProgress(undefined, snapshot([planItem("old")]));
    const next = reduceTaskProgress(
      current,
      snapshot([], {
        eventSequence: 2,
        plan: { summary: "", total: 0, completed: 0, items: [] },
      }),
    );

    expect(next).toMatchObject({
      summary: "",
      total: 0,
      completed: 0,
      items: [],
      activeItem: "",
      hasSnapshot: true,
    });
  });

  test("updates by id without merging different items with the same title", () => {
    const current = reduceTaskProgress(
      undefined,
      snapshot([
        planItem("a", "pending", 1, "Shared title"),
        planItem("b", "pending", 2, "Shared title"),
      ]),
    );
    const updated = reduceTaskProgress(
      current,
      itemUpdate(planItem("b", "done", 2, "Shared title")),
    );
    const extended = reduceTaskProgress(
      updated,
      itemUpdate(planItem("c", "blocked", 3, "Shared title"), {
        eventSequence: 3,
      }),
    );

    expect(extended?.items).toEqual([
      planItem("a", "pending", 1, "Shared title"),
      planItem("b", "done", 2, "Shared title"),
      planItem("c", "blocked", 3, "Shared title"),
    ]);
    expect(extended?.completed).toBe(1);
  });

  test("uses a title fallback only for a missing id and preserves known identity", () => {
    const current = reduceTaskProgress(
      undefined,
      snapshot([planItem("", "pending", 2, "Legacy item")]),
    );
    const identified = reduceTaskProgress(
      current,
      itemUpdate(planItem("known", "in_progress", 0, "Legacy item")),
    );
    const completed = reduceTaskProgress(
      identified,
      itemUpdate(planItem("", "done", 0, "Legacy item"), {
        eventSequence: 3,
      }),
    );

    expect(completed?.items).toEqual([
      planItem("known", "done", 2, "Legacy item"),
    ]);
  });

  test("keeps stable canonical ordering after out-of-order item delivery", () => {
    const current = reduceTaskProgress(
      undefined,
      snapshot([planItem("last", "pending", 3), planItem("first")]),
    );
    const next = reduceTaskProgress(
      current,
      itemUpdate(planItem("middle", "in_progress", 2)),
    );

    expect(next?.items.map((item) => item.id)).toEqual([
      "first",
      "middle",
      "last",
    ]);
    expect(next?.activeItem).toBe("middle");
  });

  test("applies snapshot-plus-item delivery without double counting and allows reopen", () => {
    const current = reduceTaskProgress(
      undefined,
      snapshot([planItem("first", "done")]),
    );
    const repeatedStatus = reduceTaskProgress(
      current,
      itemUpdate(planItem("first", "done"), { planTotal: 1, planCompleted: 1 }),
    );
    const reopened = reduceTaskProgress(
      repeatedStatus,
      itemUpdate(planItem("first", "in_progress"), {
        eventSequence: 3,
        planTotal: 1,
        planCompleted: 0,
      }),
    );

    expect(repeatedStatus?.completed).toBe(1);
    expect(reopened).toMatchObject({ completed: 0, activeItem: "first" });
  });

  test("uses item envelope counters before the first complete snapshot", () => {
    const next = reduceTaskProgress(
      undefined,
      itemUpdate(planItem("active", "in_progress", 7), {
        planSummary: "All requested work",
        planTotal: 8,
        planCompleted: 6,
      }),
    );

    expect(next).toMatchObject({
      summary: "All requested work",
      total: 8,
      completed: 6,
      activeItem: "active",
      hasSnapshot: false,
    });
  });

  test("rejects duplicate and older live/replay events using the shared event sequence", () => {
    const current = reduceTaskProgress(
      undefined,
      snapshot([planItem("current", "done")], { eventSequence: 20, seqNo: 20 }),
    );
    const replay = snapshot([planItem("stale")], {
      eventSequence: 20,
      seqNo: 15,
    });

    expect(reduceTaskProgress(current, replay)).toBe(current);
    expect(
      reduceTaskProgress(current, { ...replay, eventSequence: 19, seqNo: 99 }),
    ).toBe(current);
    expect(
      reduceTaskProgress(current, { ...replay, eventSequence: 21, seqNo: 16 }),
    ).toMatchObject({ completed: 0, lastEventSequence: 21 });
  });

  test("deduplicates replay-only events by seqNo when eventSequence is absent", () => {
    const event = snapshot([planItem("current")], {
      eventSequence: undefined,
      seqNo: 4,
    });
    const current = reduceTaskProgress(undefined, event);

    expect(reduceTaskProgress(current, event)).toBe(current);
    expect(reduceTaskProgress(current, { ...event, seqNo: 3 })).toBe(current);
    expect(reduceTaskProgress(current, { ...event, seqNo: 5 })).not.toBe(current);
  });

  test.each([
    { name: "tool.completed", plan: { items: [] } },
    { name: "reviewer.completed", plan: { items: [] } },
    { name: "Planner plan: 0/0 complete", plan: { items: [] } },
    { name: "Development progress: 0/0 complete", plan: { items: [] } },
    { progressSnapshot: { requestedWork: ["Invented item"], summary: "Review" } },
  ])("ignores noncanonical plan-like events: %j", (payload) => {
    expect(
      reduceTaskProgress(undefined, {
        type: "event",
        requestId: "request-1",
        ...payload,
      }),
    ).toBeUndefined();
  });

  test("requires explicit request identity and preserves request isolation", () => {
    const current = reduceTaskProgress(undefined, snapshot([planItem("owned")]));

    expect(
      reduceTaskProgress(undefined, snapshot([], { requestId: "" })),
    ).toBeUndefined();
    expect(
      reduceTaskProgress(current, snapshot([], { requestId: "request-2" })),
    ).toBe(current);
  });

  test("never changes plan status on request completion or failure", () => {
    const current = reduceTaskProgress(
      undefined,
      snapshot([planItem("unfinished", "in_progress")]),
    );
    for (const type of ["completed", "failed"]) {
      expect(
        reduceTaskProgress(current, snapshot([], { type, eventSequence: 2 })),
      ).toBe(current);
    }
  });

  test("rejects malformed snapshots without replacing the previous valid plan", () => {
    const current = reduceTaskProgress(undefined, snapshot([planItem("valid")]));
    for (const plan of [
      { items: "invalid" },
      { items: [{ title: "Invalid status", status: "unknown" }] },
      { items: [], total: -1 },
      { items: [], total: 1, completed: 2 },
    ]) {
      expect(
        reduceTaskProgress(current, snapshot([], { plan, eventSequence: 2 })),
      ).toBe(current);
    }
  });

  test("accepts legacy canonical event names with structured plan data", () => {
    const current: TaskProgress | undefined = reduceTaskProgress(
      undefined,
      snapshot([planItem("legacy")], {
        stage: undefined,
        name: "planner.plan.created",
      }),
    );

    expect(current?.items).toEqual([planItem("legacy")]);
  });
});
