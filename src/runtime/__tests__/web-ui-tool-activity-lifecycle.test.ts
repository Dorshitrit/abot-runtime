import { describe, expect, test } from "vitest";
import {
  buildConversationActivityModel,
  createConversationActivity,
} from "../../web-ui/app/components/conversation-activity.js";
import { ContextElement } from "./support/composer-context-window-dom.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

type Harness = ReturnType<typeof createPlanLifecycleHarness>;
type ActivityElement = ContextElement & { open: boolean; title: string };

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
    tool: "write_file",
    meta: { path: "notes.txt" },
    ...extra,
  };
}

function lifecycle() {
  return [
    event("tool.payload.started", 1),
    event("tool.payload.completed", 2),
    event("tool.started", 3),
    event("tool.completed", 4, {
      ok: true,
      meta: {
        path: "notes.txt",
        state: "establish_target",
        outputPreview: "Saved notes",
      },
    }),
  ];
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
        ...(status === "completed"
          ? { finalState: { status, output: "Saved answer" } }
          : {}),
      },
    ],
  };
}

function activity(harness: Harness) {
  const documentRoot = {
    createElement: (tag: string) =>
      Object.assign(new ContextElement(tag), {
        open: false,
        title: "",
        scrollTop: 0,
        scrollHeight: 500,
      }),
    defaultView: { requestAnimationFrame: () => 0 },
  } as unknown as Document;
  const renderer = createConversationActivity({ documentRoot });
  const input = (requestId: string, streaming: boolean) => ({
    requestId,
    events: harness.state.events,
    streaming,
  });
  return {
    render: (streaming = false, requestId = "request-1") =>
      renderer.createNode(input(requestId, streaming)),
    model: (streaming = false, requestId = "request-1") =>
      buildConversationActivityModel(input(requestId, streaming)),
  };
}

function child(root: HTMLElement, selector: string) {
  const found = root.querySelector(selector);
  expect(found).not.toBeNull();
  return found as unknown as ActivityElement;
}

function descendants(root: HTMLElement, className: string): ActivityElement[] {
  return [...(root as unknown as ActivityElement).children].flatMap((item) => [
    ...(item.classList.contains(className) ? [item as ActivityElement] : []),
    ...descendants(item as unknown as HTMLElement, className),
  ]);
}

describe("tool activity client lifecycle", () => {
  test("controller events become one evolving row and no repeated tool lifecycle timeline", () => {
    const harness = createPlanLifecycleHarness();
    const view = activity(harness);
    const labels = ["Preparing", "Ready", "Running", "Completed"];
    const ids = new Set();
    lifecycle().forEach((message, index) => {
      harness.realtime.handle(message);
      const node = view.render(true)!;
      const worker = child(node, ".conversation-role-card");
      expect(worker.dataset.role).toBe("worker");
      const rows = descendants(
        worker as unknown as HTMLElement,
        "conversation-tool-row",
      );
      expect(rows).toHaveLength(1);
      expect(
        child(node, ".conversation-activity-body").children[0]!.className,
      ).toBe("conversation-role-view");
      expect(child(node, ".conversation-tool-status").textContent).toBe(
        labels[index],
      );
      ids.add(child(node, ".conversation-tool").dataset.actionId);
      expect(descendants(node, "conversation-activity-event")).toHaveLength(0);
    });
    expect(ids.size).toBe(1);
    expect(harness.state.events).toHaveLength(4);
    const completed = view.render()!;
    expect(view.model().toolActions).toHaveLength(1);
    expect(child(completed, ".conversation-activity-facts").textContent).toBe(
      "1 write",
    );
    expect(child(completed, ".conversation-tool-preview").textContent).toBe(
      "Saved notes",
    );
    expect(
      descendants(completed, "conversation-tool-evidence").map((panel) =>
        panel.getAttribute("aria-label"),
      ),
    ).toEqual(["Received"]);
  });

  test("same-tool late completions keep exact pairs under their original actor", () => {
    const harness = createPlanLifecycleHarness();
    [
      event("tool.started", 1, { executionId: "a", meta: { path: "a.txt" } }),
      event("tool.started", 2, { executionId: "b", meta: { path: "b.txt" } }),
      event("agent.status", 3, {
        tool: undefined,
        executorRole: undefined,
        stage: "reviewer",
        phase: "reviewing",
      }),
      event("tool.completed", 4, {
        executionId: "b",
        ok: true,
        meta: { path: "b.txt", outputPreview: "B only" },
      }),
      event("tool.completed", 5, {
        executionId: "a",
        ok: true,
        meta: { path: "a.txt", outputPreview: "A only" },
      }),
    ].forEach(harness.realtime.handle);
    const view = activity(harness);
    const node = view.render()!;
    const actors = descendants(node, "conversation-role-card");
    const worker = actors.find((actor) => actor.dataset.role === "worker")!;
    const reviewer = actors.find((actor) => actor.dataset.role === "reviewer")!;
    const rows = descendants(
      worker as unknown as HTMLElement,
      "conversation-tool-row",
    );
    expect(rows).toHaveLength(2);
    expect(reviewer.querySelector(".conversation-tools")).toBeNull();
    expect(
      rows.map((row) => [
        child(row as unknown as HTMLElement, ".conversation-tool-target")
          .textContent,
        child(row as unknown as HTMLElement, ".conversation-tool-preview")
          .textContent,
      ]),
    ).toEqual([
      ["a.txt", "A only"],
      ["b.txt", "B only"],
    ]);
    expect(child(node, ".conversation-activity-facts").textContent).toBe(
      "2 writes",
    );
    expect(view.model().toolActions.map((action) => action.status)).toEqual([
      "completed",
      "completed",
    ]);
  });

  test("stored sessions and overlapping replay reconstruct the same complete action", async () => {
    const events = lifecycle();
    const live = createPlanLifecycleHarness();
    events.forEach(live.realtime.handle);
    const stored = createPlanLifecycleHarness(savedSession(events));
    await stored.conversationSession.openSession("session-1");
    const overlap = createPlanLifecycleHarness(
      savedSession(events.slice(0, 3), "streaming"),
      [
        { ...events[2], seqNo: 4 },
        { ...events[3], seqNo: 5 },
      ],
    );
    await overlap.conversationSession.openSession("session-1");
    overlap.realtime.handle({ ...events[3], seqNo: 6 });
    const liveView = activity(live);
    for (const harness of [stored, overlap]) {
      const view = activity(harness);
      expect(harness.state.events).toHaveLength(4);
      expect(view.model().toolActions).toEqual(liveView.model().toolActions);
      expect(child(view.render()!, ".conversation-tools").textContent).toBe(
        child(liveView.render()!, ".conversation-tools").textContent,
      );
      expect(descendants(view.render()!, "conversation-tool-row")).toHaveLength(
        1,
      );
    }
    expect(overlap.state.lastSeqByRequest.get("request-1")).toBe(6);
  });

  test("session switching isolates same execution ids and rejects late old-session events", async () => {
    const harness = createPlanLifecycleHarness();
    lifecycle().forEach(harness.realtime.handle);
    const view = activity(harness);
    expect(view.model().toolActions[0]!.target).toBe("notes.txt");
    harness.client.loadSession.mockResolvedValueOnce({
      sessionId: "session-2",
      messages: [
        {
          id: "answer-2",
          role: "assistant",
          content: "Second",
          requestId: "request-2",
        },
      ],
      requests: [
        {
          requestId: "request-2",
          status: "completed",
          events: [
            event("tool.completed", 1, {
              sessionId: "session-2",
              requestId: "request-2",
              ok: true,
              meta: { path: "second.txt", outputPreview: "Second receipt" },
            }),
          ],
        },
      ],
    });
    await harness.conversationSession.openSession("session-2");
    harness.realtime.handle(
      event("tool.completed", 5, {
        ok: true,
        meta: { path: "late-old.txt" },
      }),
    );
    expect(view.render()).toBeNull();
    expect(harness.state.events).toHaveLength(1);
    const second = view.render(false, "request-2")!;
    expect(descendants(second, "conversation-tool-row")).toHaveLength(1);
    expect(child(second, ".conversation-tool-target").textContent).toBe(
      "second.txt",
    );
    expect(second.textContent).not.toContain("late-old.txt");
  });

  test("uncorrelated legacy starts remain diagnostic until an actual outcome is recorded", () => {
    const harness = createPlanLifecycleHarness();
    const events = lifecycle().map((message) => ({
      ...message,
      executionId: undefined,
    }));
    events.slice(0, 3).forEach(harness.realtime.handle);
    const view = activity(harness);
    const pending = view.render(true)!;
    expect(pending.querySelector(".conversation-tools")).toBeNull();
    expect(descendants(pending, "conversation-activity-event")).toHaveLength(3);
    expect(view.model(true).toolActions).toEqual([]);
    harness.realtime.handle(events[3]);
    const completed = view.render()!;
    expect(descendants(completed, "conversation-tool-row")).toHaveLength(1);
    expect(descendants(completed, "conversation-activity-event")).toHaveLength(
      3,
    );
    expect(completed.textContent).toContain("Limited recorded details");
  });

  test("web sources remain visible while nested actor actions preserve disclosure across timeline toggles", () => {
    const harness = createPlanLifecycleHarness();
    harness.realtime.handle(
      event("agent.status", 1, {
        tool: undefined,
        stage: "worker",
        phase: "working",
      }),
    );
    harness.realtime.handle(
      event("tool.completed", 2, {
        tool: "web_search",
        ok: true,
        meta: {
          query: "release notes",
          webSources: {
            version: 1,
            operation: "search",
            provider: "light",
            sources: [
              {
                url: "https://example.com/article",
                title: "Article",
                retrieval: "retrieved",
                presentation: "content",
                contentTruncated: false,
              },
            ],
          },
        },
      }),
    );
    const view = activity(harness);
    const node = view.render()!;
    expect(view.model().sources).toHaveLength(1);
    expect(view.model().toolActions).toHaveLength(1);
    expect(descendants(node, "conversation-source-card")).toHaveLength(1);
    const body = child(node, ".conversation-activity-body");
    expect(body.children[0]!.className).toBe("conversation-role-view");
    const tool = child(node, ".conversation-tool");
    tool.open = true;
    tool.dispatch("toggle");
    child(node, ".conversation-role-toggle").dispatch("click");
    expect(child(node, ".conversation-role-list").hidden).toBe(true);
    expect(child(node, ".conversation-sources").hidden).toBe(false);
    const updated = view.render()!;
    child(updated, ".conversation-role-toggle").dispatch("click");
    expect(child(updated, ".conversation-tool").open).toBe(true);
    expect(descendants(node, "conversation-activity-event")).toHaveLength(1);
  });

  test.each([
    ["tool.payload.failed", "Preparation failed"],
    ["tool.approval.rejected", "Not approved"],
  ])("pre-execution %s keeps prepared-input wording", (name, label) => {
    const harness = createPlanLifecycleHarness();
    harness.realtime.handle(
      event("tool.payload.started", 1, {
        meta: { path: "notes.txt", inputPreview: "Prepared text" },
      }),
    );
    harness.realtime.handle(event(name, 2, { error: "Could not proceed" }));
    const view = activity(harness);
    const node = view.render()!;
    expect(view.model().toolActions[0]!.executed).toBe(false);
    expect(child(node, ".conversation-tool-status").textContent).toBe(label);
    expect(
      descendants(node, "conversation-tool-evidence").map((panel) =>
        panel.getAttribute("aria-label"),
      ),
    ).toEqual(["Prepared input", "Status"]);
    expect(descendants(node, "conversation-tool-row")).toHaveLength(1);
    expect(descendants(node, "conversation-activity-event")).toHaveLength(0);
  });
});
