import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  traceDebug: vi.fn(),
}));

vi.mock("../observability/debug-logger.js", () => ({
  traceDebug: mocks.traceDebug,
}));

import { createRuntimeEventBus } from "../events/runtime-emitter.js";

describe("runtime-emitter", () => {
  beforeEach(() => {
    mocks.traceDebug.mockReset();
  });

  test("keeps runtime state internal while logging diagnostics", () => {
    const sent: Array<Record<string, unknown>> = [];
    const ws = {
      send: (value: string) => {
        sent.push(JSON.parse(value) as Record<string, unknown>);
      },
    };

    const bus = createRuntimeEventBus({
      requestId: "req-runtime-state",
      ws: ws as any,
    });
    bus.runtimeState({
      stage: "decision_recovery",
      phase: "strict_retry",
      reason: "selection",
      toolIteration: 2,
      decisionAttemptCount: 3,
    });

    expect(sent).toHaveLength(0);
    expect(mocks.traceDebug).toHaveBeenCalledWith(
      "runtime.emitter",
      "runtime.state",
      {
        requestId: "req-runtime-state",
        state: {
          stage: "decision_recovery",
          phase: "strict_retry",
          reason: "selection",
          toolIteration: 2,
          decisionAttemptCount: 3,
        },
        details:
          "previous choice was not usable, tool step 2, decision attempt 3",
      },
    );
  });

  test("routes request events through one explicit persistence and delivery bus", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const persisted: Array<Record<string, unknown>> = [];
    const ws = {
      send: (value: string) => {
        sent.push(JSON.parse(value) as Record<string, unknown>);
      },
    };

    const bus = createRuntimeEventBus({
      requestId: "req-observed",
      ws: ws as any,
      persist: async (payload) => {
        persisted.push(payload);
      },
    });

    bus.event("planner.plan.created", {
      plan: {
        total: 1,
        completed: 0,
      },
    });
    bus.token("live token chunk");
    bus.completed("Done.");
    await bus.drain();
    bus.dispose();
    bus.event("planner.plan.updated", {});

    expect(sent).toHaveLength(4);
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({
      type: "event",
      requestId: "req-observed",
      eventSequence: 1,
      plan: {
        total: 1,
        completed: 0,
      },
    });
    expect(String(persisted[0]?.name)).toContain("Planner plan:");
    expect(persisted[1]).toMatchObject({
      type: "completed",
      requestId: "req-observed",
      eventSequence: 3,
      output: "Done.",
    });
  });

  test("keeps planner content client-visible while tracing only event metadata", () => {
    const sent: Array<Record<string, unknown>> = [];
    const ws = {
      send: (value: string) => {
        sent.push(JSON.parse(value) as Record<string, unknown>);
      },
    };
    const bus = createRuntimeEventBus({
      requestId: "req-plan-content",
      ws: ws as any,
    });

    bus.event("planner.plan.item.started", {
      stage: "development_plan",
      phase: "started",
      plan: {
        summary: "PRIVATE_PLAN_SUMMARY",
        total: 1,
        completed: 0,
        items: [{ title: "PRIVATE_ITEM_TITLE", status: "in_progress" }],
      },
      item: {
        title: "PRIVATE_ITEM_TITLE",
        status: "in_progress",
      },
    });

    expect(JSON.stringify(sent[0])).toContain("PRIVATE_PLAN_SUMMARY");
    expect(JSON.stringify(sent[0])).toContain("PRIVATE_ITEM_TITLE");
    expect(mocks.traceDebug).toHaveBeenCalledWith(
      "runtime.emitter",
      "ui.event.emit",
      expect.objectContaining({
        requestId: "req-plan-content",
        rawName: "planner.plan.item.started",
        emittedNameChanged: true,
        eventSequence: 1,
        stage: "development_plan",
        phase: "started",
        payloadFieldCount: 8,
      }),
    );
    expect(JSON.stringify(mocks.traceDebug.mock.calls)).not.toContain(
      "PRIVATE_PLAN_SUMMARY",
    );
    expect(JSON.stringify(mocks.traceDebug.mock.calls)).not.toContain(
      "PRIVATE_ITEM_TITLE",
    );
  });

  test("does not promote tool intent events into display status", () => {
    const sent: Array<Record<string, unknown>> = [];
    const ws = {
      send: (value: string) => {
        sent.push(JSON.parse(value) as Record<string, unknown>);
      },
    };

    const bus = createRuntimeEventBus({
      requestId: "req-tool-intent",
      ws: ws as any,
    });
    bus.event("tool.intent", {
      tool: "read_file",
      message: "I am reading the file to inspect the current content.",
      source: "model",
    });

    expect(sent).toEqual([
      expect.objectContaining({
        type: "event",
        requestId: "req-tool-intent",
        name: "tool.intent",
        tool: "read_file",
        message: "I am reading the file to inspect the current content.",
        source: "model",
      }),
    ]);
    expect(sent[0]).not.toHaveProperty("status");
  });

  test("keeps empty thinking lifecycle markers internal", () => {
    const sent: Array<Record<string, unknown>> = [];
    const ws = {
      send: (value: string) => {
        sent.push(JSON.parse(value) as Record<string, unknown>);
      },
    };
    const bus = createRuntimeEventBus({
      requestId: "req-thinking-markers",
      ws: ws as any,
    });

    bus.event("thinking.started");
    bus.event("thinking.completed");

    expect(sent).toHaveLength(0);
    expect(mocks.traceDebug).toHaveBeenCalledWith(
      "runtime.emitter",
      "internal.event",
      {
        requestId: "req-thinking-markers",
        name: "thinking.started",
        payload: {},
      },
    );
    expect(mocks.traceDebug).toHaveBeenCalledWith(
      "runtime.emitter",
      "internal.event",
      {
        requestId: "req-thinking-markers",
        name: "thinking.completed",
        payload: {},
      },
    );
  });

  test("does not trace stream deltas while preserving client payloads", () => {
    const sent: Array<Record<string, unknown>> = [];
    const ws = {
      send: (value: string) => {
        sent.push(JSON.parse(value) as Record<string, unknown>);
      },
    };
    const bus = createRuntimeEventBus({
      requestId: "req-stream",
      ws: ws as any,
    });

    bus.thinkingDelta(" next", "accumulated reasoning text");
    bus.token("answer token");

    expect(sent).toEqual([
      expect.objectContaining({
        type: "event",
        requestId: "req-stream",
        name: "thinking.delta",
        delta: " next",
        text: "accumulated reasoning text",
      }),
      expect.objectContaining({
        type: "event",
        requestId: "req-stream",
        name: "token",
        text: "answer token",
      }),
    ]);

    expect(mocks.traceDebug).not.toHaveBeenCalled();
  });
});
