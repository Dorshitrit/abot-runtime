import { describe, expect, test } from "vitest";
import { createConversationRoleCards } from "../../web-ui/app/components/conversation-role-cards.js";
import { buildConversationRoleCards } from "../../web-ui/app/lib/conversation-role-model.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

type Detail = ContextElement & { open: boolean };
type Event = Record<string, unknown>;

function receipt(overrides: Event = {}): Event {
  return {
    type: "event", name: "role.returned", requestId: "request-1",
    callerCallId: "call-1", callerRole: "supervisor", childCallId: "call-2",
    childRole: "planner", outcome: "completed", summary: "Prepared the requested plan.",
    ...overrides,
  };
}

function planning(eventSequence = 2): Event {
  return {
    type: "event", name: "runtime.state", requestId: "request-1",
    stage: "planner", phase: "planning", eventSequence, message: "Planning The Delegated Work",
  };
}

function descendants(node: ContextElement, className: string): ContextElement[] {
  return node.children.flatMap((child) => [
    ...(child.classList.contains(className) ? [child] : []),
    ...descendants(child, className),
  ]);
}

function renderer() {
  const documentRoot = {
    createElement: (tag: string) => new ContextElement(tag),
  } as unknown as Document;
  const cards = createConversationRoleCards({ documentRoot });
  function render(events: Event[]) {
    return cards.createNode({
      requestId: "request-1",
      cards: buildConversationRoleCards({ requestId: "request-1", events }),
      timeline: documentRoot.createElement("div"), hasTimeline: true,
    }) as unknown as ContextElement;
  }
  return { cards, render };
}

describe("Planner result disclosure", () => {
  test.each(["completed", "failed"])("renders the exact uncapped literal RTL summary and outcome (%s)", (outcome) => {
    const { render } = renderer();
    const summary = "  תוצאת התכנון\n<script>literal & evidence</script>  ".repeat(500);
    const node = render([planning(), receipt({ summary, outcome, eventSequence: 4 })]);
    const summaries = descendants(node, "conversation-role-return-summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.textContent).toBe(summary);
    expect(summaries[0]!.getAttribute("dir")).toBe("auto");
    expect(summaries[0]!.children).toHaveLength(0);
    expect(node.querySelector(".conversation-role-return-label")?.textContent)
      .toBe(outcome === "failed" ? "Planner failed" : "Returned result");
    expect((node.querySelector(".conversation-role-return") as Detail).open).toBe(false);
    expect(node.querySelector(".conversation-role-return-toggle")?.tagName).toBe("summary");
    expect(node.querySelector(".conversation-role-action")).toBeNull();
    expect(node.querySelector(".conversation-role-error")).toBeNull();
  });

  test("shows subsequent actual planning separately from older failed history", () => {
    const { render } = renderer();
    const node = render([receipt({ outcome: "failed", eventSequence: 4 }), planning(6)]);
    expect(node.querySelector(".conversation-role-return-label")?.textContent).toBe("Planner failed");
    expect(node.querySelector(".conversation-role-action")?.textContent).toBe("Planning The Delegated Work");
  });

  test("preserves expansion per child across rerenders and new equal-text receipts", () => {
    const { render } = renderer();
    const events = [receipt()];
    const first = render(events).querySelector(".conversation-role-return") as Detail;
    first.open = true;
    first.dispatch("toggle");
    const updated = render([...events, receipt({ childCallId: "call-3" })]);
    const details = descendants(updated, "conversation-role-return") as Detail[];
    expect(details.map((detail) => detail.open)).toEqual([true, false]);
    expect(details[0]!.dataset.returnId).not.toBe(details[1]!.dataset.returnId);
    details[0]!.open = false;
    details[0]!.dispatch("toggle");
    expect((render(events).querySelector(".conversation-role-return") as Detail).open).toBe(false);
  });

  test("ignores replaced DOM nodes and keeps delegation/return disclosure state separate", () => {
    const { render } = renderer();
    const events = [
      { ...receipt(), name: "role.delegated", objective: "Prepare the requested plan." },
      receipt(),
    ];
    const first = render(events);
    const stale = first.querySelector(".conversation-role-return") as Detail;
    const delegated = first.querySelector(".conversation-role-delegation") as Detail;
    delegated.open = true;
    delegated.dispatch("toggle");
    const current = render(events).querySelector(".conversation-role-return") as Detail;
    expect(current.open).toBe(false);
    current.open = true;
    current.dispatch("toggle");
    stale.open = false;
    stale.dispatch("toggle");
    const updated = render(events);
    expect((updated.querySelector(".conversation-role-return") as Detail).open).toBe(true);
    expect((updated.querySelector(".conversation-role-delegation") as Detail).open).toBe(true);
  });

  test.each(["forget", "reset"] as const)("clears receipt expansion on %s", (method) => {
    const { cards, render } = renderer();
    const events = [receipt()];
    const details = render(events).querySelector(".conversation-role-return") as Detail;
    details.open = true;
    details.dispatch("toggle");
    if (method === "forget") cards.forget("request-1");
    else cards.reset();
    details.dispatch("toggle");
    expect((render(events).querySelector(".conversation-role-return") as Detail).open).toBe(false);
  });

  test("does not invent result disclosure from legacy planning status", () => {
    const { render } = renderer();
    const node = render([planning()]);
    expect(node.querySelector(".conversation-role-return")).toBeNull();
    expect(node.querySelector(".conversation-role-action")?.textContent).toBe("Planning The Delegated Work");
  });
});
