import { describe, expect, test } from "vitest";
import { buildConversationStatus } from "../../web-ui/app/lib/conversation-status-model.js";
import {
  compactionEvent,
  contextSnapshotEvent,
  createScopedContextHarness,
} from "./support/context-evidence-fixture.js";

function phase(harness: ReturnType<typeof createScopedContextHarness>) {
  return buildConversationStatus({
    requestId: "request-1",
    streaming: true,
    contextWindow: harness.current(),
  });
}

describe("compaction cycle acceptance", () => {
  test("B1 keeps the second observed cycle pending through utility snapshots until its own terminal", () => {
    const h = createScopedContextHarness();
    h.send(compactionEvent("completed", 26, "first"));
    h.send(
      contextSnapshotEvent({ eventSequence: 33, measuredInputTokens: 18400 }),
    );
    h.send(
      compactionEvent("started", 35, "second", {
        modelStep: "capability.controls",
        beforeInputTokens: 26687,
      }),
    );
    h.send(
      contextSnapshotEvent({
        eventSequence: 36,
        invocationId: "compact-a",
        modelStep: "context.compact",
        measuredInputTokens: 24832,
      }),
    );
    expect(h.current()?.pendingCompaction?.invocationId).toBe("second");
    h.send(
      contextSnapshotEvent({
        eventSequence: 38,
        invocationId: "compact-b",
        modelStep: "context.compact",
        measuredInputTokens: 11680,
      }),
    );
    expect(phase(h)?.label).toBe("Compacting context");
    expect(h.current()?.lastCompaction?.invocationId).toBe("first");
    h.send(
      compactionEvent("completed", 40, "second", {
        modelStep: "capability.controls",
        beforeInputTokens: 26687,
        afterInputTokens: 5214,
      }),
    );
    expect(h.current()?.pendingCompaction).toBeNull();
    expect(h.current()?.lastCompaction).toMatchObject({
      invocationId: "second",
      modelStep: "capability.controls",
      beforePercent: 83.4,
      afterPercent: 16.3,
    });
  });

  test("B2 a smaller unrelated snapshot followed by failure never creates a success arrow", () => {
    const h = createScopedContextHarness();
    h.send(compactionEvent("started", 10));
    h.send(
      contextSnapshotEvent({ eventSequence: 11, measuredInputTokens: 100 }),
    );
    h.send(compactionEvent("failed", 12));
    expect(h.current()?.pendingCompaction).toBeNull();
    expect(h.current()?.lastCompaction).toBeNull();
    expect(h.current()?.cycles.get("outer-1")?.status).toBe("failed");
  });

  test("B3 overlapping cycles close independently in reverse completion order", () => {
    const h = createScopedContextHarness();
    h.send(compactionEvent("started", 10, "A"));
    h.send(compactionEvent("started", 11, "B"));
    h.send(compactionEvent("completed", 12, "B"));
    expect(h.current()?.openCompactionCount).toBe(1);
    expect(h.current()?.pendingCompaction?.invocationId).toBe("A");
    h.send(compactionEvent("completed", 13, "A"));
    expect(h.current()?.openCompactionCount).toBe(0);
  });

  test.each([false, true])(
    "B4 terminal before start and conflicting terminals converge (reverse=%s)",
    (reverse) => {
      const h = createScopedContextHarness();
      const receipts = [
        compactionEvent("completed", 12),
        compactionEvent("failed", 13),
      ];
      for (const event of reverse ? [...receipts].reverse() : receipts)
        h.send(event);
      h.send(compactionEvent("started", 11));
      h.send(compactionEvent("started", 99));
      h.send(receipts[0]!);
      expect(h.current()?.cycles.size).toBe(1);
      expect(h.current()?.cycles.get("outer-1")?.status).toBe("conflicted");
      expect(h.current()?.pendingCompaction).toBeNull();
      expect(h.current()?.lastCompaction).toBeNull();
    },
  );

  test.each([false, true])(
    "B4 binding contradiction cannot retain an arrival-dependent arrow (reverse=%s)",
    (reverse) => {
      const h = createScopedContextHarness();
      const events = [
        compactionEvent("started", 10),
        compactionEvent("completed", 11, "outer-1", { profileId: "other" }),
      ];
      for (const event of reverse ? [...events].reverse() : events)
        h.send(event);
      expect(h.current()?.cycles.get("outer-1")?.status).toBe("conflicted");
      expect(h.current()?.lastCompaction).toBeNull();
    },
  );

  test("B4 duplicate identity with changed terminal payload is diagnosed before activity dedup", () => {
    const h = createScopedContextHarness();
    h.send(compactionEvent("completed", 10));
    h.send(
      compactionEvent("completed", 10, "outer-1", { afterInputTokens: 20 }),
    );
    expect(h.current()?.cycles.get("outer-1")?.status).toBe("conflicted");
    expect(h.current()?.lastCompaction).toBeNull();
    expect(
      h.state.events.filter((event) => event.eventSequence === 10),
    ).toHaveLength(1);
  });

  test("B5 same role and profile cannot link invocations; scope change within one cycle is legal", () => {
    const h = createScopedContextHarness();
    h.send(
      compactionEvent("started", 10, "A", {
        compactionScope: "session_history",
      }),
    );
    h.send(compactionEvent("completed", 11, "B"));
    expect(h.current()?.pendingCompaction?.invocationId).toBe("A");
    h.send(
      compactionEvent("completed", 12, "A", {
        compactionScope: "active",
        scopeId: "active-scope",
      }),
    );
    expect(h.current()?.cycles.get("A")?.status).toBe("completed");
  });

  test.each([null, NaN, -1, "12", undefined])(
    "B6 malformed present tuple %s closes without percentage fallback",
    (afterInputTokens) => {
      const h = createScopedContextHarness();
      h.send(compactionEvent("started", 10));
      h.send(
        compactionEvent("completed", 12, "outer-1", {
          afterInputTokens,
          beforeUsedContextPercent: 80,
          afterUsedContextPercent: 10,
        }),
      );
      expect(h.current()?.pendingCompaction).toBeNull();
      expect(h.current()?.cycles.get("outer-1")?.status).toBe("completed");
      expect(h.current()?.lastCompaction).toBeNull();
    },
  );

  test("B6 zero and a different capacity derive arrows only from terminal counts", () => {
    const h = createScopedContextHarness();
    h.send(contextSnapshotEvent({ contextWindowTokens: 32000 }));
    h.send(
      compactionEvent("completed", 11, "outer-1", {
        contextWindowTokens: 100,
        beforeInputTokens: 80,
        afterInputTokens: 0,
        beforeUsedContextPercent: 90,
        afterUsedContextPercent: 50,
      }),
    );
    expect(h.current()?.lastCompaction).toMatchObject({
      beforePercent: 80,
      afterPercent: 0,
    });
  });

  test("B11 request terminal interrupts pending; earlier canonical terminal can arrive late", () => {
    const h = createScopedContextHarness();
    h.send(compactionEvent("started", 10));
    h.send({
      type: "failed",
      requestId: "request-1",
      eventSequence: 20,
      error: "request_cancelled",
    });
    expect(h.current()?.cycles.get("outer-1")?.status).toBe("interrupted");
    h.send(compactionEvent("completed", 15));
    expect(h.current()?.cycles.get("outer-1")?.status).toBe("completed");
    expect(h.current()?.pendingCompaction).toBeNull();
    expect(h.assistant.streaming).toBe(false);
  });

  test.each(["completed", "failed"])(
    "B11 terminal-first %s partial replay cannot resurrect compaction",
    (type) => {
      const h = createScopedContextHarness();
      h.send({ type, requestId: "request-1", eventSequence: 20 });
      h.send(compactionEvent("started", 10));
      expect(h.current()?.cycles.get("outer-1")?.status).toBe("interrupted");
      expect(h.current()?.pendingCompaction).toBeNull();
      h.send(compactionEvent("completed", 21));
      expect(h.current()?.cycles.get("outer-1")?.status).toBe("interrupted");
      expect(h.current()?.lastCompaction).toBeNull();
    },
  );

  test.each([false, true])(
    "B11 a compaction terminal after request end remains interrupted in either delivery order (reverse=%s)",
    (reverse) => {
      const h = createScopedContextHarness();
      const events = [
        { type: "failed", requestId: "request-1", eventSequence: 20 },
        compactionEvent("completed", 21),
      ];
      for (const event of reverse ? [...events].reverse() : events)
        h.send(event);
      expect(h.current()?.cycles.get("outer-1")?.status).toBe("interrupted");
      expect(h.current()?.pendingCompaction).toBeNull();
      expect(h.current()?.lastCompaction).toBeNull();
    },
  );

  test.each([false, true])(
    "B11 an unordered canonical request end preserves explicit completion in either delivery order (reverse=%s)",
    (reverse) => {
      const h = createScopedContextHarness();
      const events = [
        {
          type: "event",
          name: "request.lifecycle.changed",
          lifecycle: {
            schemaVersion: 1,
            requestId: "request-1",
            generation: "generation-1",
            revision: 2,
            status: "completed",
          },
        },
        compactionEvent("completed", 21),
      ];
      for (const event of reverse ? [...events].reverse() : events)
        h.send(event);
      expect(h.current()?.cycles.get("outer-1")?.status).toBe("completed");
      expect(h.current()?.lastCompaction?.invocationId).toBe("outer-1");
      expect(h.current()?.pendingCompaction).toBeNull();
      expect(h.assistant.streaming).toBe(false);
    },
  );

  test("B11 rejected lifecycle revisions cannot interrupt a current cycle through event recording", () => {
    const h = createScopedContextHarness();
    const lifecycle = {
      schemaVersion: 1,
      requestId: "request-1",
      generation: "generation-1",
      revision: 3,
      status: "streaming",
    };
    h.send({
      type: "event",
      name: "request.lifecycle.changed",
      lifecycle,
      eventSequence: 10,
    });
    h.send(compactionEvent("started", 11));
    h.send({
      type: "event",
      name: "request.lifecycle.changed",
      eventSequence: 12,
      lifecycle: { ...lifecycle, revision: 2, status: "failed" },
    });
    expect(h.current()?.cycles.get("outer-1")?.status).toBe("pending");
    h.send({
      type: "event",
      name: "request.lifecycle.changed",
      eventSequence: 13,
      lifecycle: { ...lifecycle, revision: 4, status: "failed" },
    });
    expect(h.current()?.cycles.get("outer-1")?.status).toBe("interrupted");
  });

  test.each(["completed", "failed"])(
    "B13 %s stops utility status without provider usage or another snapshot",
    (terminal) => {
      const h = createScopedContextHarness();
      h.send(compactionEvent("started", 10));
      h.send(
        contextSnapshotEvent({
          eventSequence: 11,
          modelStep: "context.compact",
        }),
      );
      expect(phase(h)?.label).toBe("Compacting context");
      h.send(
        contextSnapshotEvent({
          eventSequence: 12,
          modelStep: "context.compact",
          contextWindowTokens: null,
        }),
      );
      expect(h.current()?.snapshot).toBeNull();
      expect(phase(h)?.label).toBe("Compacting context");
      h.send(compactionEvent(terminal, 13));
      expect(phase(h)?.label).toBe("Working");
    },
  );
});
