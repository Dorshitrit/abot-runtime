import { describe, expect, test } from "vitest";
import { createConversationActivity } from "../../web-ui/app/components/conversation-activity.js";
import { projectToolActivityEvent } from "../../web-ui/app/lib/tool-activity-event.js";
import { enrichEventPayload } from "../events/event-status.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

type Element = ContextElement & { open: boolean };

function createActivity() {
  const documentRoot = {
    createElement: (tag: string) => Object.assign(new ContextElement(tag), { open: false }),
  } as unknown as Document;
  const view = createConversationActivity({ documentRoot });
  return (events: Record<string, unknown>[], streaming = false) => view.createNode({
    requestId: "request-1", events, streaming,
  })!;
}

function readEvent(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "request-1", eventSequence: 2, executionId: "skill-1",
    name: "tool.completed", tool: "abot_skills", executorRole: "worker", ok: true,
    meta: { skillAction: "read_skills", skillIds: ["technical-work", "review"],
      skillTitle: "Technical Work, Review (Code, Tests)" },
    ...overrides,
  };
}

function child(root: HTMLElement, selector: string): Element {
  const node = root.querySelector(selector);
  expect(node).not.toBeNull();
  return node as unknown as Element;
}

describe("Skill collection presentation", () => {
  test("groups Supervisor phase evidence without parsing names or counting tools", () => {
    const summary = 'Read Skills: סקירה (קוד, בדיקות), <img src=x> Technical Work';
    const node = createActivity()([{
      requestId: "request-1", eventSequence: 1, name: "runtime.state",
      stage: "supervisor", phase: "skills", message: summary,
    }]);
    const collection = child(node, ".conversation-skill-collection");
    expect(collection.getAttribute("aria-label")).toBe("Skill activity");
    const row = child(node, ".conversation-role-skill-activity");
    expect(row.textContent).toBe('סקירה (קוד, בדיקות), <img src=x> Technical Work');
    expect(row.getAttribute("title")).toBe(summary);
    expect(row.getAttribute("dir")).toBe("auto");
    expect(row.tagName).toBe("li");
    expect(collection.querySelector(".conversation-skill-icon")?.getAttribute("aria-hidden")).toBe("true");
    expect(node.querySelector(".conversation-skill-heading")).toBeNull();
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector(".conversation-tool")).toBeNull();
  });

  test("collects ordinary reads into one row while keeping diagnostics separate and in order", () => {
    const messages = [
      "Read Skills: Technical Work", "Read Skills: ABot Studio",
      "Skill lookup failed: knowledge_skill_not_found",
      "Read Skills: Review (Code, Tests)",
      "Skill lookup failed: knowledge_skill_store_unavailable",
    ];
    const node = createActivity()(messages.map((message, index) => enrichEventPayload({
      type: "event", requestId: "request-1", eventSequence: index + 1, name: "runtime.state",
      stage: "supervisor", phase: "skills", message,
    })));
    const collection = child(node, ".conversation-skill-collection");
    expect(collection.children).toHaveLength(4);
    const groups = collection.children;
    const first = groups[0]!;
    expect(first.children.map((node) => node.className)).toEqual([
      "conversation-skill-icon", "conversation-skill-read-label", "conversation-skill-items",
    ]);
    expect(first.children[2]!.children.map((item) => item.textContent)).toEqual(["Technical Work", "ABot Studio"]);
    expect(first.children[2]!.children.map((item) => item.getAttribute("title"))).toEqual(messages.slice(0, 2));
    expect(groups[1]!.querySelector(".conversation-role-skill-activity")?.dataset.tone).toBe("neutral");
    expect(groups[2]!.querySelector(".conversation-role-skill-activity")?.getAttribute("title")).toBe(messages[3]);
    expect(groups[3]!.querySelector(".conversation-role-skill-activity")?.dataset.tone).toBe("failed");
  });

  test.each([
    ["Read skill: One, complete name", "One, complete name", true],
    ["Read Skills: One, complete name", "One, complete name", true],
    ["Listed 2 Skills", "Listed 2 Skills", false],
    ["Read Skills: ", "Read Skills:", false],
    ["Read Skills : Unknown format", "Read Skills : Unknown format", false],
    ["Unrelated Read Skills: literal text", "Unrelated Read Skills: literal text", false],
  ])("only formats a known read prefix within classified Skill activity: %s", (summary, display, labelledRead) => {
    const node = createActivity()([{
      requestId: "request-1", eventSequence: 1, name: "runtime.state",
      stage: "supervisor", phase: "skills", message: summary,
    }]);
    const row = child(node, ".conversation-role-skill-activity");
    expect(row.textContent).toBe(display);
    expect(row.getAttribute("title")).toBe(summary.trim());
    expect(Boolean(node.querySelector(".conversation-skill-read-label"))).toBe(labelledRead);
  });

  test.each(["supervisor", "worker"])("styles declared read metadata for %s and preserves disclosure on refresh", (executorRole) => {
    const render = createActivity();
    const event = readEvent({ executorRole });
    const action = child(render([event]), ".conversation-tool");
    expect(action.classList.contains("is-skill-read")).toBe(true);
    expect(action.classList.contains("is-completed")).toBe(true);
    expect(child(action as unknown as HTMLElement, ".conversation-tool-target").textContent)
      .toBe("Technical Work, Review (Code, Tests)");
    expect(child(action as unknown as HTMLElement, ".conversation-skill-icon").getAttribute("aria-hidden")).toBe("true");
    action.open = true;
    action.dispatch("toggle");
    const refreshed = child(render([event, event]), ".conversation-tool");
    expect(refreshed.open).toBe(true);
    expect(refreshed.textContent).toContain("technical-work, review");
    expect(refreshed.querySelector(".conversation-tool-body")).not.toBeNull();
  });

  test.each([
    { name: "tool.started", ok: undefined, streaming: true, expected: "is-running" },
    { name: "tool.completed", ok: false, streaming: false, expected: "is-failed" },
    { name: "tool.completed", ok: undefined, streaming: false, expected: "is-incomplete" },
  ])("does not present $expected as successful collection", ({ name, ok, streaming, expected }) => {
    const node = createActivity()([readEvent({ name, ok, error: "knowledge_skill_not_found" })], streaming);
    const action = child(node, ".conversation-tool");
    expect(action.classList.contains("is-skill-read")).toBe(true);
    expect(action.classList.contains(expected)).toBe(true);
    expect(action.classList.contains("is-completed")).toBe(false);
    expect(child(node, ".conversation-tool-target").textContent).toBe("technical-work, review");
    expect(action.textContent).toContain("knowledge_skill_not_found");
  });

  test.each(["list_skills", "create_skill", "update_skill", "unknown"])("does not style %s as a read", (skillAction) => {
    const event = readEvent({ meta: { skillAction, skillName: "Read Skills: Anything" } });
    expect(projectToolActivityEvent(event)?.skillRead).toBeUndefined();
    expect(child(createActivity()([event]), ".conversation-tool").classList.contains("is-skill-read")).toBe(false);
  });

  test("never uses a message prefix or another tool's metadata as a Skill signal", () => {
    const event = readEvent({ tool: "read_file", meta: { skillAction: "read_skill", path: "guide.md" } });
    expect(projectToolActivityEvent(event)?.skillRead).toBeUndefined();
    const node = createActivity()([event, {
      requestId: "request-1", eventSequence: 3, name: "runtime.state",
      stage: "worker", phase: "working", message: "Read Skills: Technical Work",
    }]);
    expect(node.querySelector(".conversation-skill-collection")).toBeNull();
    expect(child(node, ".conversation-tool").classList.contains("is-skill-read")).toBe(false);
  });
});
