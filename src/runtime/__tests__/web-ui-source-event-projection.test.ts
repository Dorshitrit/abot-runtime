import { describe, expect, test } from "vitest";

import { projectWebSourceEvent } from "../../web-ui/app/lib/web-source-event.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

function sourceEvent(eventSequence = 8, requestId = "request-1") {
  return {
    type: "event",
    name: "tool.completed",
    requestId,
    sessionId: "session-1",
    eventSequence,
    tool: "web_search",
    ok: true,
    meta: {
      query: "Web sources",
      urls: ["https://example.com/article"],
      webSources: {
        version: 1,
        operation: "search",
        provider: "light",
        sources: [
          {
            url: "https://example.com/article",
            title: "An article",
            retrieval: "retrieved",
            presentation: "content",
            contentTruncated: true,
          },
        ],
      },
    },
  };
}

function savedSession(events: Record<string, unknown>[], status = "completed") {
  return {
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
        status,
        events,
        finalState:
          status === "completed"
            ? { status: "completed", output: "Saved answer" }
            : undefined,
      },
    ],
  };
}

describe("Web source event projection", () => {
  test("keeps only the bounded receipt from live completed web tools", () => {
    const { realtime, state } = createPlanLifecycleHarness();
    const event = sourceEvent();
    realtime.handle({
      ...event,
      meta: { ...event.meta, rawPage: "Do not retain full page content" },
    });

    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      requestId: "request-1",
      eventSequence: 8,
      tool: "web_search",
      webSources: event.meta.webSources,
    });
    expect(state.events[0]).not.toHaveProperty("meta");
    expect(JSON.stringify(state.events)).not.toContain("rawPage");
  });

  test("reconstructs the same receipt through the real stored-session path", async () => {
    const live = createPlanLifecycleHarness();
    live.realtime.handle(sourceEvent());
    const history = createPlanLifecycleHarness(
      savedSession([{ ...sourceEvent(), seqNo: 3, timestamp: 1000 }]),
    );
    await history.conversationSession.openSession("session-1");

    expect(history.state.events[0]?.webSources).toEqual(
      live.state.events[0]?.webSources,
    );
    expect(history.state.events[0]).toMatchObject({
      requestId: "request-1",
      eventSequence: 8,
      lastSeqNo: 3,
    });
  });

  test("deduplicates overlapping live/replay receipts without merging distinct calls", async () => {
    const first = sourceEvent();
    const next = sourceEvent(9);
    const harness = createPlanLifecycleHarness(
      savedSession([{ ...first, seqNo: 3 }], "streaming"),
      [
        { ...first, seqNo: 4 },
        { ...next, seqNo: 5 },
      ],
    );
    await harness.conversationSession.openSession("session-1");

    expect(harness.state.events).toHaveLength(2);
    expect(harness.state.events.map((event) => event.eventSequence)).toEqual([
      8, 9,
    ]);
    expect(harness.state.lastSeqByRequest.get("request-1")).toBe(5);
    expect(harness.state.events.every((event) => event.count === 1)).toBe(true);
  });

  test("retains separate unsequenced source outcomes without overwriting the first", () => {
    const { realtime, state } = createPlanLifecycleHarness();
    const first = { ...sourceEvent(), eventSequence: undefined };
    const next = { ...sourceEvent(), eventSequence: undefined };
    next.meta.webSources.sources[0]!.presentation = "omitted";
    realtime.recordEvent(first);
    realtime.recordEvent(next);

    expect(state.events).toHaveLength(2);
    expect(state.events[0]?.webSources).toMatchObject({
      sources: [{ presentation: "content" }],
    });
    expect(state.events[1]?.webSources).toMatchObject({
      sources: [{ presentation: "omitted" }],
    });
  });

  test("keeps request identities separate and clears receipts when changing session", async () => {
    const harness = createPlanLifecycleHarness();
    harness.realtime.recordEvent(sourceEvent(8, "request-1"));
    harness.realtime.recordEvent(sourceEvent(8, "request-2"));
    expect(harness.state.events.map((event) => event.requestId)).toEqual([
      "request-1",
      "request-2",
    ]);
    harness.client.loadSession.mockResolvedValueOnce({
      sessionId: "session-2",
      messages: [],
      requests: [],
    });
    await harness.conversationSession.openSession("session-2");
    expect(harness.state.events).toEqual([]);
    harness.realtime.handle(sourceEvent());
    expect(harness.state.events).toEqual([]);
  });

  test.each([
    { name: "tool.started" },
    { name: "tool.completed", ok: false },
    { name: "tool.completed", tool: "read_file" },
  ])(
    "ignores source claims outside successful web completions: %s",
    (overrides) => {
      expect(
        projectWebSourceEvent({ ...sourceEvent(), ...overrides }),
      ).toBeNull();
    },
  );

  test.each([null, { version: 2 }, { version: 1, sources: "invalid" }])(
    "does not reinterpret an unsupported receipt as legacy evidence: %s",
    (webSources) => {
      const event = sourceEvent();
      expect(
        projectWebSourceEvent({
          ...event,
          meta: { ...event.meta, webSources },
        }),
      ).toBeNull();
    },
  );

  test("restores old metadata without claiming content exposure or a Brave provider", () => {
    const event = sourceEvent();
    expect(
      projectWebSourceEvent({
        ...event,
        meta: { urls: event.meta.urls, fetchedUrls: event.meta.urls },
      }),
    ).toMatchObject({
      version: 0,
      sources: [{ retrieval: "retrieved", presentation: "unknown" }],
    });
    expect(
      projectWebSourceEvent({
        ...event,
        meta: { urls: event.meta.urls },
      }),
    ).not.toHaveProperty("provider", "brave");
  });

  test("preserves ordinary Activity coalescing when no source receipt exists", () => {
    const { realtime, state } = createPlanLifecycleHarness();
    const event = {
      type: "event",
      name: "Working...",
      requestId: "request-1",
      stage: "worker",
      phase: "working",
    };
    realtime.recordEvent(event);
    realtime.recordEvent(event);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ count: 2 });
    expect(state.events[0]).not.toHaveProperty("webSources");
  });
});
