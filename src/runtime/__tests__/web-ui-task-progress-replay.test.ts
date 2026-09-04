import { describe, expect, test } from "vitest";

import {
  reduceTaskProgress,
  type TaskProgressItem,
} from "../../web-ui/app/lib/task-progress.js";

function item(
  id: string,
  status: TaskProgressItem["status"],
  order = 1,
): TaskProgressItem {
  return { id, title: id, status, order };
}

function event(sequence: number, payload: Record<string, unknown>) {
  return {
    type: "event",
    requestId: "request-1",
    stage: "development_plan",
    phase: "updated",
    eventSequence: sequence,
    ...payload,
  };
}

function snapshot(sequence: number, items: TaskProgressItem[]) {
  return event(sequence, {
    plan: {
      summary: `Snapshot ${sequence}`,
      total: items.length,
      completed: items.filter((entry) => entry.status === "done").length,
      items,
    },
  });
}

describe.each(["eventSequence", "seqNo"] as const)(
  "task progress replay ordering with %s",
  (source) => {
    function withSequenceDomain(message: Record<string, unknown>) {
      if (source === "eventSequence") return { ...message, seqNo: 99 };
      return {
        ...message,
        eventSequence: undefined,
        seqNo: message.eventSequence,
      };
    }

    test("reconstructs the baseline and delayed suffix without rolling newer progress back", () => {
      const firstLive = withSequenceDomain(
        event(6, {
          item: item("c", "blocked", 3),
          planTotal: 3,
          planCompleted: 2,
          planSummary: "Latest summary",
        }),
      );
      let state = reduceTaskProgress(undefined, firstLive);
      state = reduceTaskProgress(
        state,
        withSequenceDomain(
          event(5, {
            item: item("b", "done", 2),
            planTotal: 3,
            planCompleted: 2,
            planSummary: "Earlier summary",
          }),
        ),
      );
      state = reduceTaskProgress(
        state,
        withSequenceDomain(
          snapshot(2, [
            item("a", "pending"),
            item("b", "pending", 2),
            item("c", "pending", 3),
          ]),
        ),
      );

      expect(state).toMatchObject({
        total: 3,
        completed: 2,
        summary: "Latest summary",
        items: [
          item("a", "pending"),
          item("b", "done", 2),
          item("c", "blocked", 3),
        ],
      });

      const replaySuffix = withSequenceDomain(
        event(3, {
          item: item("a", "done"),
          planTotal: 3,
          planCompleted: 1,
          planSummary: "Old replay summary",
        }),
      );
      state = reduceTaskProgress(state, replaySuffix);
      expect(state).toMatchObject({
        completed: 2,
        summary: "Latest summary",
        items: [
          item("a", "done"),
          item("b", "done", 2),
          item("c", "blocked", 3),
        ],
      });
      expect(reduceTaskProgress(state, firstLive)).toBe(state);
      expect(reduceTaskProgress(state, replaySuffix)).toBe(state);
      expect(
        state?.[source === "eventSequence" ? "lastEventSequence" : "lastSeqNo"],
      ).toBe(6);
    });

    test("advances the snapshot baseline independently and never resurrects removed items", () => {
      let state = reduceTaskProgress(
        undefined,
        withSequenceDomain(
          snapshot(2, [item("old", "pending"), item("b", "pending", 2)]),
        ),
      );
      const live = withSequenceDomain(
        event(8, {
          item: item("b", "done", 2),
          planTotal: 2,
          planCompleted: 1,
        }),
      );
      state = reduceTaskProgress(state, live);
      const intermediate = withSequenceDomain(
        snapshot(6, [item("new", "in_progress"), item("b", "pending", 2)]),
      );
      state = reduceTaskProgress(state, intermediate);

      expect(state).toMatchObject({
        total: 2,
        completed: 1,
        activeItem: "new",
        items: [item("new", "in_progress"), item("b", "done", 2)],
      });
      state = reduceTaskProgress(
        state,
        withSequenceDomain(snapshot(10, [item("new", "blocked")])),
      );
      expect(state).toMatchObject({
        total: 1,
        completed: 0,
        activeItem: "",
        items: [item("new", "blocked")],
        replayState: { itemUpdates: [] },
      });
      expect(reduceTaskProgress(state, intermediate)).toBe(state);
      expect(reduceTaskProgress(state, live)).toBe(state);
    });
  },
);

test("preserves optional metadata and discards covered delta history at the next snapshot", () => {
  const first = event(1, {
    item: item("only", "in_progress"),
    planTotal: 1,
    planCompleted: 0,
    planSummary: "Preserved metadata",
  });
  let state = reduceTaskProgress(undefined, first);
  for (let sequence = 2; sequence <= 50; sequence += 1) {
    state = reduceTaskProgress(
      state,
      event(sequence, {
        item: item("only", sequence % 2 ? "in_progress" : "done"),
      }),
    );
  }

  expect(state).toMatchObject({ summary: "Preserved metadata", completed: 1 });
  expect(reduceTaskProgress(state, first)).toBe(state);
  state = reduceTaskProgress(state, snapshot(51, []));
  expect(state?.replayState?.itemUpdates).toEqual([]);
  expect(state?.items).toEqual([]);
});

test("never uses a different request's replay as a partial-plan baseline", () => {
  const current = reduceTaskProgress(
    undefined,
    event(8, {
      item: item("owned", "in_progress"),
    }),
  );
  const foreignSnapshot = {
    ...snapshot(2, [item("foreign", "done")]),
    requestId: "request-2",
  };

  expect(reduceTaskProgress(current, foreignSnapshot)).toBe(current);
  expect(current?.hasSnapshot).toBe(false);
  expect(current?.items).toEqual([item("owned", "in_progress")]);
});

test.each([{ order: [2, 3, 4] }, { order: [4, 3, 2] }, { order: [3, 4, 2] }])(
  "preserves intermediate item states around an optional counter: $order",
  ({ order }) => {
    let state = reduceTaskProgress(
      undefined,
      snapshot(1, [item("a", "pending"), item("b", "pending", 2)]),
    );
    const updates = new Map([
      [2, event(2, { item: item("a", "done") })],
      [3, event(3, { item: item("b", "done", 2), planCompleted: 2 })],
      [4, event(4, { item: item("a", "in_progress") })],
    ]);
    for (const sequence of order) {
      state = reduceTaskProgress(state, updates.get(sequence)!);
    }

    expect(state).toMatchObject({
      total: 2,
      completed: 1,
      items: [item("a", "in_progress"), item("b", "done", 2)],
    });
  },
);

test("restores older same-item metadata without replacing the newer live status", () => {
  let state = reduceTaskProgress(
    undefined,
    event(8, {
      item: item("a", "in_progress"),
    }),
  );
  state = reduceTaskProgress(
    state,
    event(3, {
      item: item("a", "pending"),
      planSummary: "Restored metadata",
      planTotal: 4,
      planCompleted: 2,
    }),
  );

  expect(state).toMatchObject({
    summary: "Restored metadata",
    total: 4,
    completed: 2,
    activeItem: "a",
    items: [item("a", "in_progress")],
    lastEventSequence: 8,
  });
});
