import { describe, expect, test } from "vitest";
import { createConversationRoleCards } from "../../web-ui/app/components/conversation-role-cards.js";
import { buildConversationToolActions } from "../../web-ui/app/lib/tool-activity-model.js";
import type { ConversationRoleCard } from "../../web-ui/app/lib/conversation-role-model.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

type RoleElement = ContextElement & { open: boolean };

function roleDom() {
  return {
    createElement: (tag: string) =>
      Object.assign(new ContextElement(tag), { open: false }),
  } as unknown as Document;
}

function child(root: HTMLElement, selector: string) {
  const found = root.querySelector(selector);
  expect(found).not.toBeNull();
  return found as unknown as RoleElement;
}

function card(
  role: ConversationRoleCard["role"] = "worker",
  id = role,
): ConversationRoleCard {
  const toolActions = buildConversationToolActions({
    requestId: "request-1",
    events: [
      {
        requestId: "request-1",
        eventSequence: 1,
        executionId: id,
        executorRole: role,
        name: "tool.completed",
        tool: "read_file",
        ok: true,
        meta: { path: `${role}.txt`, outputPreview: `${role} evidence` },
      },
    ],
  });
  return {
    id,
    role,
    title: role === "unknown" ? "Unattributed actions" : role,
    responsibility: "Recorded activity",
    phaseLabel: "",
    summary: "",
    facts: ["1 tool call"],
    active: false,
    tone: "recorded",
    toolActions,
  };
}

function renderer() {
  const documentRoot = roleDom();
  const roles = createConversationRoleCards({ documentRoot });
  return {
    roles,
    render(cards = [card()], requestId = "request-1") {
      return roles.createNode({
        requestId,
        cards,
        timeline: documentRoot.createElement("div"),
        hasTimeline: true,
      });
    },
  };
}

function roleRows(node: HTMLElement) {
  return child(node, ".conversation-role-list").children as RoleElement[];
}

describe("tools nested in actor cards", () => {
  test("renders each action within its actor without a standalone Tools heading", () => {
    const { render } = renderer();
    const node = render([card("worker"), card("reviewer")]);
    const rows = roleRows(node);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const root = row as unknown as HTMLElement;
      const tools = child(root, ".conversation-tools");
      expect(tools.getAttribute("aria-label")).toBe(
        `${row.dataset.role} tool activity`,
      );
      expect(child(root, ".conversation-tool-target").textContent).toBe(
        `${row.dataset.role}.txt`,
      );
      expect(tools.querySelector(".conversation-tools-title")).toBeNull();
      expect(child(root, ".conversation-tool-preview").textContent).toBe(
        `${row.dataset.role} evidence`,
      );
    }
    expect(node.querySelector(".conversation-role-summary")).toBeNull();
  });

  test("multiple actors retain independent disclosure state after both render", () => {
    const { render } = renderer();
    const cards = [card("worker"), card("reviewer")];
    const first = roleRows(render(cards));
    const worker = child(
      first[0] as unknown as HTMLElement,
      ".conversation-tool",
    );
    worker.open = true;
    worker.dispatch("toggle");
    const updated = roleRows(render(cards));
    expect(
      child(updated[0] as unknown as HTMLElement, ".conversation-tool").open,
    ).toBe(true);
    const reviewer = child(
      updated[1] as unknown as HTMLElement,
      ".conversation-tool",
    );
    expect(reviewer.open).toBe(false);
    reviewer.open = true;
    reviewer.dispatch("toggle");
    const completed = roleRows(render(cards));
    expect(
      completed.map(
        (row) =>
          child(row as unknown as HTMLElement, ".conversation-tool").open,
      ),
    ).toEqual([true, true]);
    expect(
      roleRows(render(cards, "request-2")).map(
        (row) =>
          child(row as unknown as HTMLElement, ".conversation-tool").open,
      ),
    ).toEqual([false, false]);
  });

  test("actor/timeline toggles and rerenders preserve an expanded action", () => {
    const { render } = renderer();
    const node = render();
    const tool = child(node, ".conversation-tool");
    tool.open = true;
    tool.dispatch("toggle");
    const toggle = child(node, ".conversation-role-toggle");
    toggle.dispatch("click");
    expect(child(node, ".conversation-role-list").hidden).toBe(true);
    const updated = render();
    expect(child(updated, ".conversation-role-list").hidden).toBe(true);
    child(updated, ".conversation-role-toggle").dispatch("click");
    expect(child(updated, ".conversation-role-list").hidden).toBe(false);
    expect(child(updated, ".conversation-tool").open).toBe(true);
  });

  test.each(["forget", "reset", "remove"] as const)(
    "%s clears nested disclosure and ignores old actor nodes",
    (operation) => {
      const { roles, render } = renderer();
      const old = child(render(), ".conversation-tool");
      old.open = true;
      old.dispatch("toggle");
      if (operation === "forget") roles.forget("request-1");
      if (operation === "reset") roles.reset();
      if (operation === "remove") render([]);
      expect(child(render(), ".conversation-tool").open).toBe(false);
      old.dispatch("toggle");
      expect(child(render(), ".conversation-tool").open).toBe(false);
    },
  );

  test("an unattributed actor gets an accessible title and generic avatar", () => {
    const node = renderer().render([card("unknown")]);
    expect(child(node, ".conversation-role-title").textContent).toBe(
      "Unattributed actions",
    );
    expect(child(node, ".conversation-role-avatar").textContent).toBe("•");
    expect(child(node, ".conversation-tools").getAttribute("aria-label")).toBe(
      "Unattributed actions tool activity",
    );
  });
});
