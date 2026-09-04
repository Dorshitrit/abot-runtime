import { describe, expect, test } from "vitest";

import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import { countToolInvocations } from "../../web-ui/app/lib/tool-invocation-count.js";

describe("web ui tool invocation count", () => {
  test("counts an execution once across its lifecycle", () => {
    expect(
      countToolInvocations([
        { eventName: "tool.payload.started" },
        { eventName: "tool.payload.completed" },
        { eventName: "tool.approval.required" },
        { eventName: "tool.approval.granted" },
        { eventName: "tool.started" },
        { eventName: "tool.completed" },
      ]),
    ).toBe(1);
  });

  test("counts repeated calls to the same tool separately", () => {
    expect(
      countToolInvocations([
        { eventName: "tool.started", tool: "read_file" },
        { eventName: "tool.completed", tool: "read_file" },
        { eventName: "tool.started", tool: "read_file" },
        { eventName: "tool.completed", tool: "read_file", ok: false },
      ]),
    ).toBe(2);
  });

  test("counts an in-flight start without waiting for completion", () => {
    expect(countToolInvocations([{ eventName: "tool.started" }])).toBe(1);
  });

  test("preserves grouped start multiplicities", () => {
    expect(
      countToolInvocations([
        { eventName: "tool.started", count: 3 },
        { eventName: "tool.completed", count: 3 },
        { eventName: "tool.started", count: 2 },
      ]),
    ).toBe(5);
  });

  test.each([undefined, null, "3", NaN, Infinity, -Infinity, 0, -2, 0.5])(
    "normalizes unsupported or subunit start multiplicity %s to one",
    (count) => {
      expect(countToolInvocations([{ eventName: "tool.started", count }])).toBe(
        1,
      );
    },
  );

  test("does not infer starts from terminal or preparation-only history", () => {
    expect(
      countToolInvocations([
        { eventName: "tool.completed", count: 3 },
        { eventName: "tool.failed" },
        { eventName: "tool.payload.started" },
        { eventName: "tool.payload.failed" },
        { eventName: "tool.approval.required" },
        { eventName: "tool.approval.rejected" },
        { eventName: "tool.intent" },
      ]),
    ).toBe(0);
  });

  test("uses the exact normalized event name, not display text", () => {
    expect(
      countToolInvocations([
        { eventName: "tool.started", name: "Reading source" },
        { eventName: "tool.payload.started", name: "tool.started" },
        { eventName: "tool.started.extra" },
        { name: "tool.started" },
      ]),
    ).toBe(1);
  });

  test("counts before display grouping can merge distinct lifecycle stages", () => {
    const activity = buildConversationActivityModel({
      requestId: "request-current",
      events: [
        {
          requestId: "request-current",
          eventName: "tool.payload.started",
          name: "Preparing operation",
          summary: "Same display text",
          tone: "active",
        },
        {
          requestId: "request-current",
          eventName: "tool.started",
          name: "Preparing operation",
          summary: "Same display text",
          tone: "active",
          count: 2,
        },
        {
          requestId: "request-other",
          eventName: "tool.started",
          count: 5,
        },
      ],
    });

    expect(activity.toolCount).toBe(2);
    expect(activity.eventCount).toBe(3);
    expect(activity.events).toHaveLength(1);
    expect(activity.events[0].count).toBe(3);
  });

  test("keeps failed completion evidence separate from invocation count", () => {
    const activity = buildConversationActivityModel({
      requestId: "request-current",
      events: [
        {
          requestId: "request-current",
          name: "tool.started",
          tool: "read_file",
        },
        {
          requestId: "request-current",
          name: "tool.completed",
          tool: "read_file",
          ok: false,
        },
      ],
    });

    expect(activity.toolCount).toBe(1);
    expect(activity.failureCount).toBe(1);
    expect(activity.events).toHaveLength(2);
    expect(activity.events[1].tone).toBe("failed");
  });
});
