import { describe, expect, test } from "vitest";

import { buildConversationStatus } from "../../web-ui/app/lib/conversation-status-model.js";
import { canReplaceContextWindowEvidence } from "../../web-ui/app/lib/context-window-snapshot-order.js";

function context(
  modelStep = "worker.decision",
  eventSequence = 10,
  extra: Record<string, unknown> = {},
) {
  return {
    requestId: "request-1",
    snapshot: {
      requestId: "request-1",
      invocationId: "invocation-1",
      admissionOutcome: "accepted",
      modelStep,
      eventSequence,
    },
    ...extra,
  };
}

function toolEvent(
  name: string,
  eventSequence: number,
  extra: Record<string, unknown> = {},
) {
  return {
    requestId: "request-1",
    type: "event",
    name,
    tool: "write_file",
    executionId: "execution-1",
    eventSequence,
    ...extra,
  };
}

function status(extra: Record<string, unknown> = {}) {
  return buildConversationStatus({
    requestId: "request-1",
    streaming: true,
    contextWindow: context(),
    ...extra,
  });
}

describe("conversation status model phases", () => {
  test.each([
    ["supervisor.decision", "Making a decision"],
    ["execution.decision", "Making a decision"],
    ["worker.decision", "Making a decision"],
    ["capability.controls", "Making a decision"],
    ["planner.decision", "Planning"],
    ["planner.graph", "Planning"],
    ["reviewer.decision", "Reviewing"],
    ["auditor.decision", "Reviewing"],
    ["worker.result", "Summarizing results"],
    ["supervisor.response", "Preparing response"],
    ["execution.response", "Preparing response"],
    ["degraded.finalization", "Preparing response"],
    ["context.compact", "Compacting context"],
    ["tool_payload.raw", "Working"],
    ["future.decision", "Working"],
    ["constructor", "Working"],
  ])("presents %s without inferring an unknown role", (modelStep, label) => {
    expect(status({ contextWindow: context(modelStep) })).toEqual({
      label,
      animate: true,
    });
  });

  test("keeps stopped, completed, and unbound requests inactive", () => {
    expect(buildConversationStatus()).toBeNull();
    expect(status({ streaming: false })).toBeNull();
    expect(status({ requestId: "" })).toBeNull();
    expect(status({ requestId: " ", connected: false })).toBeNull();
    expect(status({ streaming: false, connected: false })).toBeNull();
  });

  test("uses Working until this exact request has an accepted snapshot", () => {
    const invalid = [
      null,
      { requestId: "request-1" },
      context("worker.decision", 10, { requestId: "other" }),
      context("worker.decision", 10, {
        snapshot: { ...context().snapshot, requestId: "other" },
      }),
      context("worker.decision", 10, {
        snapshot: { ...context().snapshot, requestId: undefined },
      }),
      context("worker.decision", 10, {
        snapshot: { ...context().snapshot, admissionOutcome: "rejected" },
      }),
    ];
    for (const contextWindow of invalid) {
      expect(status({ contextWindow })).toEqual({
        label: "Working",
        animate: true,
      });
    }
  });

  test("does not advertise live work while disconnected", () => {
    expect(status({ connected: false })).toEqual({
      label: "Reconnecting",
      animate: false,
    });
    expect(status({ connected: true })?.label).toBe("Making a decision");
  });

  test("matching provider usage settles only its current invocation", () => {
    expect(
      status({
        contextWindow: context("supervisor.response", 10, {
          providerUsage: { invocationId: "earlier-invocation" },
        }),
      })?.label,
    ).toBe("Preparing response");
    expect(
      status({
        contextWindow: context("supervisor.response", 10, {
          providerUsage: { invocationId: "invocation-1" },
        }),
      })?.label,
    ).toBe("Working");
  });
});

describe("conversation status tool and compaction precedence", () => {
  test("follows correlated preparation, approval, execution, and model continuation", () => {
    const events: Record<string, unknown>[] = [];
    const expected = [
      "Working",
      "Waiting for approval",
      "Working",
      "Running tool",
      "Working",
    ];
    const phases = [
      "tool.payload.started",
      "tool.approval.required",
      "tool.approval.granted",
      "tool.started",
      "tool.completed",
    ];
    phases.forEach((name, index) => {
      events.push(toolEvent(name, 11 + index, { ok: true }));
      expect(status({ events })).toEqual({
        label: expected[index],
        animate: name !== "tool.approval.required",
      });
    });
    expect(
      status({ events, contextWindow: context("reviewer.decision", 16) })
        ?.label,
    ).toBe("Reviewing");
  });

  test("uses tool lifecycle ordering for replay and isolated executions", () => {
    const completed = toolEvent("tool.completed", 14, { ok: true });
    const started = toolEvent("tool.started", 11);
    const required = toolEvent("tool.approval.required", 12);
    expect(
      status({ events: [completed, started, required, completed] })?.label,
    ).toBe("Working");
    expect(
      status({
        events: [
          completed,
          toolEvent("tool.started", 15, { executionId: "execution-2" }),
          started,
        ],
      })?.label,
    ).toBe("Running tool");
    expect(
      status({
        events: [
          toolEvent("tool.started", 11),
          toolEvent("tool.approval.required", 12, {
            executionId: "execution-2",
          }),
        ],
      }),
    ).toEqual({ label: "Waiting for approval", animate: false });
  });

  test("ignores foreign requests and uncorrelated active tool history", () => {
    const events = [
      toolEvent("tool.started", 11, { requestId: "other" }),
      toolEvent("tool.approval.required", 12, { requestId: "other" }),
      toolEvent("tool.started", 13, { executionId: undefined }),
    ];
    expect(status({ events })?.label).toBe("Making a decision");
  });

  test("settled tool evidence clears an older model phase in the matching sequence domain", () => {
    const completed = toolEvent("tool.completed", 11, {
      ok: true,
      lastSeqNo: 1,
    });
    expect(status({ events: [completed] })?.label).toBe("Working");
    expect(
      status({
        events: [completed],
        contextWindow: context("reviewer.decision", 12),
      })?.label,
    ).toBe("Reviewing");
    const transportContext = context("worker.decision", 10, {
      snapshot: { ...context().snapshot, eventSequence: undefined, seqNo: 8 },
    });
    expect(
      status({
        contextWindow: transportContext,
        events: [
          toolEvent("tool.failed", 11, {
            eventSequence: undefined,
            lastSeqNo: 9,
          }),
        ],
      })?.label,
    ).toBe("Working");
    expect(
      status({ contextWindow: transportContext, events: [completed] })?.label,
    ).toBe("Making a decision");
  });

  test("active tool and compaction work survives provider usage from a completed model call", () => {
    const contextWindow = context("context.compact", 10, {
      providerUsage: { invocationId: "invocation-1" },
      pendingCompaction: { beforePercent: 80 },
    });
    expect(status({ contextWindow })?.label).toBe("Compacting context");
    expect(
      status({ contextWindow, events: [toolEvent("tool.started", 11)] })?.label,
    ).toBe("Running tool");
    expect(
      status({
        contextWindow,
        events: [toolEvent("tool.approval.required", 11)],
      })?.animate,
    ).toBe(false);
    expect(
      status({ contextWindow: { ...contextWindow, requestId: "other" } })
        ?.label,
    ).toBe("Working");
  });
});

describe("context snapshot sequence replacement", () => {
  test("original event sequence takes precedence over transport replay numbering", () => {
    const previous = { eventSequence: 10, seqNo: 20 };
    expect(
      canReplaceContextWindowEvidence(previous, {
        eventSequence: 9,
        seqNo: 30,
      }),
    ).toBe(false);
    expect(
      canReplaceContextWindowEvidence(previous, {
        eventSequence: 10,
        seqNo: 31,
      }),
    ).toBe(false);
    expect(
      canReplaceContextWindowEvidence(previous, {
        eventSequence: 11,
        seqNo: 19,
      }),
    ).toBe(true);
  });

  test("compares transport sequence only when both records provide that domain", () => {
    expect(canReplaceContextWindowEvidence({ seqNo: 10 }, { seqNo: 9 })).toBe(
      false,
    );
    expect(canReplaceContextWindowEvidence({ seqNo: 10 }, { seqNo: 10 })).toBe(
      false,
    );
    expect(canReplaceContextWindowEvidence({ seqNo: 10 }, { seqNo: 11 })).toBe(
      true,
    );
    expect(
      canReplaceContextWindowEvidence({ eventSequence: 10 }, { seqNo: 3 }),
    ).toBe(true);
    expect(
      canReplaceContextWindowEvidence({ seqNo: 10 }, { eventSequence: 3 }),
    ).toBe(true);
    expect(canReplaceContextWindowEvidence(undefined, {})).toBe(true);
    expect(
      canReplaceContextWindowEvidence(
        { eventSequence: Number.NaN },
        { eventSequence: 0 },
      ),
    ).toBe(true);
  });
});
