import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only view.
import { createConversationView } from "../../web-ui/app/components/conversation-view.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

type Item = Record<string, unknown>;
class ViewElement extends ContextElement {
  scrollTop = 0;
  open = false;
  set innerHTML(value: string) { this.textContent = value; }
  get innerHTML() { return this.textContent; }
}
function nodes(root: ContextElement, selector: string): ContextElement[] {
  return root.children.flatMap((child) => [
    ...(child.matches(selector) ? [child] : []), ...nodes(child, selector),
  ]);
}
const requestId = "request-1";
const answer = (text = "", streaming = true): Item => ({ id: "answer", role: "assistant", requestId, text, streaming });
const update = (id: string, eventSequence: number): Item => ({
  id, role: "assistant", kind: "user_interaction", requestId, text: id,
  streaming: false, interactionSequence: eventSequence, eventSequence,
});
const tool = (eventSequence: number, name: string, extra: Item = {}): Item => ({
  type: "event", requestId, name, eventSequence, tool: "read_file", executionId: "read-1",
  executorRole: "supervisor", meta: { path: "notes.md" }, ...extra,
});
function fixture(messages: Item[], events: Item[]) {
  const documentRoot = { createElement: (tag: string) => new ViewElement(tag) };
  const messagesList = documentRoot.createElement("div");
  const copyText = vi.fn(async () => undefined);
  const view = createConversationView({
    dom: { messagesList, jumpToLatestButton: documentRoot.createElement("button") },
    documentRoot, viewport: {}, getMessages: () => messages,
    getActiveRequestId: () => requestId, getActivityForMessage: () => ({ events }),
    getPendingApprovals: () => [], createApprovalCard: () => documentRoot.createElement("aside"),
    copyText, notify: () => {}, showContextWindow: false, showReasoning: false,
    scrollBehavior: { afterRender() {} },
  });
  return { view, messagesList, copyText };
}
function panel(root: ContextElement) { return root.querySelector(".conversation-work-panel")!; }
function toggle(root: ContextElement) { return root.querySelector(".conversation-work-toggle")!; }

describe("default chat work timeline integration", () => {
  test("interleaves EA updates, collapses on final answer, and preserves reopening and exact Copy", async () => {
    const messages = [answer(), update("Before reading", 1), update("Read verified", 4)];
    const events = [tool(2, "tool.started"), tool(3, "tool.completed", { ok: true })];
    const f = fixture(messages, events);
    f.view.render();
    expect(f.messagesList.children).toHaveLength(1);
    expect(f.messagesList.querySelector(".conversation-progress")).toBeNull();
    expect(panel(f.messagesList).hidden).toBe(false);
    expect(nodes(f.messagesList, ".conversation-work-entry").map((node) => node.textContent))
      .toEqual([expect.stringContaining("Before reading"), expect.stringContaining("Read file"), expect.stringContaining("Read verified")]);
    const final = "**Exact answer**\n\nKeep this spacing.  \n";
    messages[0] = answer(final, false);
    events.push({ type: "completed", requestId, eventSequence: 5 });
    const original = structuredClone({ messages, events });
    f.view.render();
    expect(panel(f.messagesList).hidden).toBe(true);
    expect(toggle(f.messagesList).textContent).toContain("Show timeline");
    toggle(f.messagesList).dispatch("click");
    expect(panel(f.messagesList).hidden).toBe(false);
    f.view.render();
    expect(panel(f.messagesList).hidden).toBe(false);
    const copy = nodes(f.messagesList, "button").find((node) => node.getAttribute("aria-label") === "Copy response")!;
    copy.dispatch("click");
    await Promise.resolve();
    expect(f.copyText).toHaveBeenCalledExactlyOnceWith(final);
    expect({ messages, events }).toEqual(original);
  });

  test("shows SUPER acknowledge and intent while excluding unmarked reasoning", () => {
    const events = [
      { type: "event", name: "thinking.delta", requestId, eventSequence: 1, presentationKind: "acknowledgement", text: "I will inspect the file." },
      { type: "event", name: "thinking.delta", requestId, eventSequence: 2, text: "Private model reasoning" },
      tool(3, "tool.started", { intent: "Read the existing notes." }),
      tool(4, "tool.completed", { ok: true, intent: "Read the existing notes." }),
    ];
    const f = fixture([answer()], events);
    f.view.render();
    const text = panel(f.messagesList).textContent;
    expect(text).toContain("I will inspect the file.");
    expect(text).toContain("Read the existing notes.");
    expect(text).not.toContain("Private model reasoning");
    expect(nodes(f.messagesList, ".conversation-work-message")).toHaveLength(2);
    expect(nodes(f.messagesList, ".conversation-tool")).toHaveLength(1);
    expect(f.messagesList.querySelector(".conversation-role-card")).toBeNull();
  });

  test.each(["approval", "failed", "stopped"])("keeps %s activity open without claiming a final answer", (state) => {
    const message = answer("Pending or partial response", false);
    if (state === "approval") message.kind = "tool_approval_request";
    const events: Item[] = [tool(1, "tool.started")];
    if (state !== "approval") events.push({ type: "failed", requestId, eventSequence: 2, error: state === "stopped" ? "request_cancelled" : "provider_failure" });
    const f = fixture([message], events);
    f.view.render();
    expect(panel(f.messagesList).hidden).toBe(false);
  });

  test("renders a request-scoped update before an assistant placeholder exists", () => {
    const f = fixture([update("Initial progress", 1)], []);
    f.view.render();
    expect(panel(f.messagesList).hidden).toBe(false);
    expect(f.messagesList.textContent).toContain("Initial progress");
    expect(f.messagesList.querySelector(".message-meta")).toBeNull();
  });
});
