import { describe, expect, test } from "vitest";
import {
  buildConversationActivityModel,
  createConversationActivity,
} from "../../web-ui/app/components/conversation-activity.js";
import { createRealtimeContextHarness } from "./support/realtime-context-harness.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

function event(state: string, sequence: number, extra: Record<string, unknown> = {}) {
  return {
    type: "event", requestId: "request-1", eventSequence: sequence,
    name: `memory.retrieval.${state}`, stage: "long_term_memory",
    ...extra,
  };
}

function model(events: Record<string, unknown>[], streaming = false) {
  return buildConversationActivityModel({ requestId: "request-1", events, streaming });
}

function renderer() {
  const documentRoot = {
    createElement: (tag: string) => Object.assign(new ContextElement(tag), { open: false }),
  } as unknown as Document;
  return createConversationActivity({ documentRoot });
}

function nodes(root: ContextElement, className: string): ContextElement[] {
  const matches = root.classList.contains(className) ? [root] : [];
  return matches.concat(...root.children.map((child) => nodes(child, className)));
}

function render(events: Record<string, unknown>[], streaming = false) {
  return renderer().createNode({ requestId: "request-1", events, streaming }) as unknown as ContextElement;
}

describe("compact memory activity", () => {
  test("replaces the started row with its result without changing recorded evidence", () => {
    const events = [event("started", 1), event("completed", 2)];
    const original = structuredClone(events);
    expect(model(events.slice(0, 1), true).memoryActivities).toMatchObject([{ state: "active" }]);
    const completed = model(events);
    expect(completed.memoryActivities).toEqual([{ state: "done", label: "Memory checked", detail: "" }]);
    expect(completed.events).toEqual([]);
    expect(completed.hasContent).toBe(true);
    expect(events).toEqual(original);
    const node = render(events);
    expect(node.tagName).toBe("div");
    expect(node.classList.contains("conversation-role-message")).toBe(true);
    expect(node.querySelector(".conversation-memory-activity")).not.toBeNull();
    expect(nodes(node, "conversation-memory-row")).toHaveLength(1);
    expect(node.querySelector("details")).toBeNull();
    expect(node.querySelector(".conversation-activity-summary")).toBeNull();
    expect(node.textContent).not.toContain("Started");
    expect(node.textContent).not.toContain("2 events");
  });

  test("keeps a failure outcome and its reason visible as text", () => {
    const node = render([event("started", 1), event("failed", 2, {
      reason: "embedding unavailable <img src=x>",
    })]);
    const rows = nodes(node, "conversation-memory-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dataset.state).toBe("failed");
    expect(node.textContent).toContain("Memory retrieval failed");
    expect(node.textContent).toContain("embedding unavailable <img src=x>");
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector(".conversation-memory-detail")?.getAttribute("dir")).toBe("auto");
  });

  test("distinguishes an unfinished request from an actively running check", () => {
    expect(model([event("started", 1)], true).memoryActivities[0]?.state).toBe("active");
    expect(model([event("started", 1)], false).memoryActivities[0]?.state).toBe("incomplete");
    expect(render([event("started", 1)]).textContent).not.toContain("Memory checked");
  });

  test("replaces earlier retrieval episodes with the latest request status", () => {
    const events = [
      event("started", 1), event("failed", 2, { reason: "unavailable" }),
      event("started", 3), event("completed", 4),
    ];
    expect(model(events).memoryActivities.map((item) => item.state)).toEqual(["done"]);
    expect(nodes(render(events), "conversation-memory-row")).toHaveLength(1);
    expect(events).toHaveLength(4);
  });

  test("shows one latest state even for multiple starts or unpaired outcomes", () => {
    const events = [event("started", 1), event("started", 2), event("completed", 3)];
    expect(model(events).memoryActivities.map((item) => item.state)).toEqual(["done"]);
    expect(model([event("completed", 1), event("completed", 2)]).memoryActivities)
      .toHaveLength(1);
    expect(model([...events, event("started", 4)], true).memoryActivities[0]?.state)
      .toBe("active");
  });

  test("preserves the latest failure instead of keeping an earlier success", () => {
    const activity = model([event("completed", 1), event("failed", 2, { reason: "offline" })]);
    expect(activity.memoryActivities).toEqual([{
      state: "failed", label: "Memory retrieval failed", detail: "offline",
    }]);
  });

  test("uses request scope across stages and phases without swallowing other memory operations", () => {
    const events = [
      event("started", 1),
      event("completed", 2, { requestId: "request-other" }),
      event("completed", 3, { phase: "other-phase" }),
      event("failed", 4, { stage: "other-stage", reason: "other failure" }),
      event("completed", 5),
      { ...event("started", 6), name: "memory.save.queued" },
      { ...event("started", 7), name: "tool.started", tool: "memory_search" },
    ];
    const activity = model(events);
    expect(activity.memoryActivities.map((item) => item.state)).toEqual(["done"]);
    expect(model([event("started", 1), event("completed", 2, { requestId: "request-other" })], true)
      .memoryActivities[0]?.state).toBe("active");
    expect(activity.events.map((item) => item.eventName)).toEqual(["memory.save.queued", "tool.started"]);
    expect(activity.toolCount).toBe(1);
    const node = render(events);
    expect(node.querySelector(".conversation-activity-summary")).not.toBeNull();
    expect(node.textContent).toContain("Memory Save Queued");
    expect(nodes(node, "conversation-activity-event").map((item) => item.textContent).join(" "))
      .not.toContain("Memory Retrieval");
  });

  test.each(["eventSequence", "seqNo"] as const)("reconstructs delayed replay with %s and deduplicates its event identities", (field) => {
    const ordered = [event("started", 1), event("completed", 2)];
    const messages = ordered.map((item) => field === "eventSequence" ? item : {
      ...item, eventSequence: undefined, seqNo: item.eventSequence,
    });
    const delayed = [messages[1]!, messages[0]!, messages[1]!];
    expect(model(delayed).memoryActivities).toEqual(model(ordered).memoryActivities);
  });

  test.each(["completed", "failed"])("live and restored UI records have the same %s presentation", (state) => {
    const messages = [event("started", 1), event(state, 2, { reason: state === "failed" ? "offline" : "" })];
    const live = createRealtimeContextHarness();
    const restored = createRealtimeContextHarness();
    for (const message of messages) live.controller.recordEvent(message);
    for (const message of messages) restored.controller.recordEvent({ ...message, seqNo: message.eventSequence + 10 });
    expect(live.state.events).toHaveLength(2);
    expect(restored.state.events).toHaveLength(2);
    expect(model(live.state.events).memoryActivities).toEqual(model(restored.state.events).memoryActivities);
    expect(render(live.state.events).textContent).toBe(render(restored.state.events).textContent);
    expect(model(messages).memoryActivities).toEqual(model(live.state.events).memoryActivities);
  });

  test("keeps existing role cards and compact Skill collection alongside memory", () => {
    const node = render([
      event("started", 1), event("completed", 2),
      { requestId: "request-1", eventSequence: 3, name: "runtime.state",
        stage: "supervisor", phase: "skills", message: "Read Skills: Technical Work" },
    ]);
    expect(node.classList.contains("conversation-activity-group")).toBe(false);
    expect(nodes(node, "conversation-memory-row")).toHaveLength(1);
    const bubble = node.querySelector(".conversation-role-message");
    expect(bubble?.querySelector(".conversation-memory-row")).not.toBeNull();
    expect(bubble?.querySelector(".conversation-skill-collection")).not.toBeNull();
    expect(node.querySelector(".conversation-role-card")).not.toBeNull();
    expect(node.querySelector(".conversation-skill-collection")).not.toBeNull();
    expect(node.textContent).toContain("Technical Work");
    expect(nodes(node, "conversation-activity-event").map((item) => item.textContent).join(" "))
      .not.toContain("Memory Retrieval");
  });
});
