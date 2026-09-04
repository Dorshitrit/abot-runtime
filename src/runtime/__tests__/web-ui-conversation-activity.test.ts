import { describe, expect, test } from "vitest";

import {
  buildConversationActivityModel,
  pinConversationActivityToLatest,
} from "../../web-ui/app/components/conversation-activity.js";

describe("web ui conversation activity", () => {
  test("keeps tool and failure events scoped to their assistant request", () => {
    const activity = buildConversationActivityModel({
      requestId: "req-current",
      streaming: true,
      events: [
        {
          type: "event",
          name: "tool.started",
          requestId: "req-current",
          tool: "web_search",
        },
        {
          type: "event",
          name: "tool.completed",
          requestId: "req-current",
          tool: "web_search",
        },
        {
          type: "event",
          name: "tool.started",
          requestId: "req-current",
          tool: "read_file",
        },
        {
          type: "event",
          name: "tool.failed",
          requestId: "req-current",
          tool: "read_file",
          error: "not found",
        },
        {
          type: "event",
          name: "tool.completed",
          requestId: "req-other",
          tool: "write_file",
        },
      ],
    });

    expect(activity.events.map((event) => event.eventName)).toEqual([
      "tool.started",
      "tool.completed",
      "tool.started",
      "tool.failed",
    ]);
    expect(activity.events.at(-1)).toMatchObject({
      name: "file reader failed",
      tone: "failed",
    });
    expect(activity.toolCount).toBe(2);
    expect(activity.failureCount).toBe(1);
    expect(activity.openByDefault).toBe(true);
    expect(activity.currentLabel).toBe("file reader failed");
    expect(activity.hasContent).toBe(true);
  });

  test("binds task progress to the matching request only", () => {
    const progress = {
      requestId: "req-current",
      summary: "Prepare the release",
      completed: 0,
      total: 2,
      items: [
        { id: "one", title: "Inspect", status: "done", order: 1 },
        { id: "two", title: "Verify", status: "active", order: 2 },
      ],
    };

    const activity = buildConversationActivityModel({
      requestId: "req-current",
      taskProgress: progress,
    });
    expect(activity.progress).toMatchObject({
      summary: "Prepare the release",
      completed: 1,
      total: 2,
    });
    expect(activity.hasContent).toBe(true);
    expect(activity.openByDefault).toBe(false);

    expect(
      buildConversationActivityModel({
        requestId: "req-other",
        taskProgress: progress,
      }).hasContent,
    ).toBe(false);
  });

  test("preserves presented event counts and failure tones", () => {
    const activity = buildConversationActivityModel({
      requestId: "req-current",
      events: [
        {
          key: "req-current|tool.started",
          requestId: "req-current",
          eventName: "tool.started",
          name: "Using web search",
          tone: "active",
          count: 2,
        },
        {
          key: "req-current|tool.completed",
          requestId: "req-current",
          eventName: "tool.completed",
          name: "web search completed",
          tone: "done",
          count: 2,
        },
        {
          key: "req-current|request.failed",
          requestId: "req-current",
          eventName: "request.failed",
          name: "Response failed",
          summary: "provider unavailable",
          tone: "failed",
        },
      ],
    });

    expect(activity.eventCount).toBe(5);
    expect(activity.toolCount).toBe(2);
    expect(activity.failureCount).toBe(1);
    expect(activity.latestLabel).toBe("Response failed");
    expect(activity.currentLabel).toBe("");
  });

  test("pins an open streaming activity to its latest event only", () => {
    const details = { open: true };
    const body = { scrollTop: 80, scrollHeight: 640 };

    expect(
      pinConversationActivityToLatest({ details, body, streaming: true }),
    ).toBe(true);
    expect(body.scrollTop).toBe(640);

    details.open = false;
    body.scrollTop = 120;
    expect(
      pinConversationActivityToLatest({ details, body, streaming: true }),
    ).toBe(false);
    expect(body.scrollTop).toBe(120);
  });
});
