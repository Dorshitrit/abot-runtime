import { describe, expect, test } from "vitest";
import { createConversationRoleCards } from "../../web-ui/app/components/conversation-role-cards.js";
import { buildConversationRoleCards } from "../../web-ui/app/lib/conversation-role-model.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

type Detail = ContextElement & { open: boolean };
type Event = Record<string, unknown>;

function delegation(childCallId = "call-2", objective = "Inspect the requested evidence."): Event {
  return {
    type: "event", name: "role.delegated", requestId: "request-1",
    callerCallId: "call-1", callerRole: "supervisor", childCallId,
    childRole: "planner", objective,
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

describe("Supervisor delegation disclosure", () => {
  test("renders recipient and exact long RTL objective once with independent status", () => {
    const { render } = renderer();
    const objective = "  בדוק את המקורות\n".repeat(500).slice(0, 8_192);
    const node = render([
      delegation("call-2", objective),
      {
        type: "event", name: "runtime.state", requestId: "request-1",
        stage: "supervisor", phase: "resuming", message: "Processing The Delegated Result",
      },
    ]);
    const objectives = descendants(node, "conversation-role-delegation-objective");
    expect(objectives).toHaveLength(1);
    expect(objectives[0]!.textContent).toBe(objective);
    expect(objectives[0]!.getAttribute("dir")).toBe("auto");
    expect(node.querySelector(".conversation-role-delegation-label")?.textContent).toBe("Delegated to Planner");
    expect(node.querySelector(".conversation-role-action")?.textContent).toBe("Processing The Delegated Result");
    expect((node.querySelector(".conversation-role-delegation") as Detail).open).toBe(false);
    expect(node.querySelector(".conversation-role-delegation-toggle")?.tagName).toBe("summary");
    expect(node.querySelector(".conversation-role-title")?.textContent).toBe("Supervisor");
  });

  test("preserves open and closed state independently across rerenders and new delegations", () => {
    const { render } = renderer();
    const events = [delegation()];
    const first = render(events).querySelector(".conversation-role-delegation") as Detail;
    first.open = true;
    first.dispatch("toggle");
    const updated = render([...events, delegation("call-3")]);
    const details = descendants(updated, "conversation-role-delegation") as Detail[];
    expect(details.map((detail) => detail.open)).toEqual([true, false]);
    details[0]!.open = false;
    details[0]!.dispatch("toggle");
    expect((render(events).querySelector(".conversation-role-delegation") as Detail).open).toBe(false);
  });

  test("ignores toggle events from replaced DOM nodes", () => {
    const { render } = renderer();
    const events = [delegation()];
    const stale = render(events).querySelector(".conversation-role-delegation") as Detail;
    const current = render(events).querySelector(".conversation-role-delegation") as Detail;
    current.open = true;
    current.dispatch("toggle");
    stale.open = false;
    stale.dispatch("toggle");
    expect((render(events).querySelector(".conversation-role-delegation") as Detail).open).toBe(true);
  });

  test.each(["forget", "reset"] as const)("clears disclosure state on %s", (method) => {
    const { cards, render } = renderer();
    const events = [delegation()];
    const details = render(events).querySelector(".conversation-role-delegation") as Detail;
    details.open = true;
    details.dispatch("toggle");
    if (method === "forget") cards.forget("request-1");
    else cards.reset();
    details.dispatch("toggle");
    expect((render(events).querySelector(".conversation-role-delegation") as Detail).open).toBe(false);
  });

  test("keeps distinct calls with the same objective as independent history rows", () => {
    const { render } = renderer();
    const node = render([delegation("call-2"), delegation("call-3")]);
    const details = descendants(node, "conversation-role-delegation") as Detail[];
    expect(details).toHaveLength(2);
    expect(details[0]!.dataset.delegationId).not.toBe(details[1]!.dataset.delegationId);
    details[0]!.open = true;
    details[0]!.dispatch("toggle");
    expect(details[1]!.open).toBe(false);
  });

  test("renders no invented delegation disclosure for older role status events", () => {
    const { render } = renderer();
    const node = render([{
      type: "event", name: "runtime.state", requestId: "request-1",
      stage: "supervisor", phase: "resuming", message: "Processing The Delegated Result",
    }]);
    expect(node.querySelector(".conversation-role-delegation")).toBeNull();
    expect(node.querySelector(".conversation-role-action")?.textContent).toBe("Processing The Delegated Result");
  });
});
