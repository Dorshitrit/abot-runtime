import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only view.
import { createConversationView } from "../../web-ui/app/components/conversation-view.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

type Message = Record<string, unknown>;
class ViewElement extends ContextElement {
  scrollTop = 0;
  set innerHTML(value: string) { this.textContent = value; }
  get innerHTML() { return this.textContent; }
}

function matchingNodes(root: ContextElement, selector: string): ContextElement[] {
  return root.children.flatMap((child) => [
    ...(child.matches(selector) ? [child] : []), ...matchingNodes(child, selector),
  ]);
}
const update = (id: string, text = id): Message => ({
  id, kind: "user_interaction", role: "assistant", requestId: "request-1", text,
  streaming: false, thinkingText: "Update private reasoning", createdAt: "2026-10-27T12:00:00.000Z",
});
const response = (text = "", streaming = true): Message => ({
  id: "answer", role: "assistant", requestId: "request-1", text, streaming,
  thinkingText: "Agent reasoning", createdAt: "2026-10-27T12:00:01.000Z",
});

function fixture(messages: Message[], options: {
  showReasoning?: boolean; statusPlacement?: string; preserveMessageHistory?: boolean;
  activity?: boolean; pendingApproval?: boolean;
} = {}) {
  const documentRoot = { createElement: (tag: string) => new ViewElement(tag) };
  const dom = { messagesList: documentRoot.createElement("div"), jumpToLatestButton: documentRoot.createElement("button") };
  const createActivity = vi.fn(() => {
    if (options.activity === false) return null;
    const node = documentRoot.createElement("aside");
    node.className = "conversation-activity";
    node.textContent = "Tool activity and agent bubbles";
    return node;
  });
  const approval = documentRoot.createElement("aside");
  approval.className = "pending-approval-card";
  const copyText = vi.fn(async () => undefined);
  const notify = vi.fn();
  const view = createConversationView({
    dom, documentRoot, viewport: {}, getMessages: () => messages,
    getActiveRequestId: () => "request-1", getActivityForMessage: () => ({ events: [] }),
    getPendingApprovals: () => options.pendingApproval ? [{}] : [], createApprovalCard: () => approval,
    copyText, notify, createActivityView: () => ({ createNode: createActivity, reset() {} }),
    showReasoning: options.showReasoning ?? true, showContextWindow: false,
    statusPlacement: options.statusPlacement ?? "bubble", preserveMessageHistory: options.preserveMessageHistory ?? false,
    scrollBehavior: { afterRender() {} },
  });
  return { ...dom, view, copyText, notify, createActivity, approval };
}

function expectProgressOnly(group: ContextElement) {
  expect(group.tagName).toBe("section");
  expect(group.getAttribute("aria-label")).toBe("Progress updates");
  for (const selector of [".message-avatar", ".message-meta", "time", "button", ".message-actions", ".thinking-body"])
    expect(group.querySelector(selector)).toBeNull();
}

function expectProgressOrder(row: ContextElement, expected: string[]) {
  const bubble = row.querySelector(".message-bubble")!;
  const group = bubble.querySelector(".conversation-progress")!;
  const activity = bubble.querySelector(".conversation-activity")!;
  const reasoning = bubble.querySelector(".conversation-reasoning")!;
  const finalBody = bubble.children.find((child) => child.classList.contains("markdown-body"))!;
  expect(activity).not.toBeNull();
  expect(reasoning).not.toBeNull();
  expect(finalBody).toBeDefined();
  expect(bubble.children.indexOf(group)).toBeGreaterThan(bubble.children.indexOf(activity));
  expect(bubble.children.indexOf(group)).toBeGreaterThan(bubble.children.indexOf(reasoning));
  expect(bubble.children.indexOf(group)).toBeLessThan(bubble.children.indexOf(finalBody));
  expect(matchingNodes(group, ".conversation-progress-item").map((item) => item.textContent.trim())).toEqual(expected);
  expectProgressOnly(group);
  return finalBody;
}

describe("grouped user interaction rendering", () => {
  test("keeps live updates after activity and reasoning, then before the unchanged final answer", async () => {
    const messages = [response(), update("first", "First update")];
    const f = fixture(messages);
    f.view.render();
    expect(f.messagesList.children).toHaveLength(1);
    expectProgressOrder(f.messagesList.children[0]!, ["<p>First update</p>"]);
    messages.push(update("second", "Second update"));
    const final = "**Exact final**\n\nKeep this spacing.  \n";
    messages[0] = response(final, false);
    const before = structuredClone(messages);
    f.view.render();
    expect(f.messagesList.children).toHaveLength(1);
    const row = f.messagesList.children[0]!;
    expectProgressOrder(row, ["<p>First update</p>", "<p>Second update</p>"]);
    expect(messages).toEqual(before);
    expect(matchingNodes(row, "button")).toHaveLength(1);
    row.querySelector("button")!.dispatch("click");
    await Promise.resolve();
    expect(f.copyText).toHaveBeenCalledExactlyOnceWith(final);
    expect(f.notify).toHaveBeenCalledWith("Response copied");
  });

  test.each([true, false])("renders one safe fallback group without message metadata (reasoning=%s)", (showReasoning) => {
    const messages = [update("first", "**Update**\nשלום <script>alert(1)</script>"), update("second", "Next update")];
    const before = structuredClone(messages);
    const f = fixture(messages, { showReasoning });
    f.view.render();
    const groups = matchingNodes(f.messagesList, ".conversation-progress");
    expect(groups).toHaveLength(1);
    expectProgressOnly(groups[0]!);
    const items = matchingNodes(groups[0]!, ".conversation-progress-item");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("<strong>Update</strong>");
    expect(items[0]!.textContent).toContain("&lt;script&gt;");
    expect(items[0]!.textContent).not.toContain("<script>");
    expect(matchingNodes(groups[0]!, ".rtl-text")).toHaveLength(1);
    expect(f.createActivity).not.toHaveBeenCalled();
    expect(matchingNodes(f.messagesList, "button")).toHaveLength(0);
    expect(messages).toEqual(before);
  });

  test("keeps SPARK progress visible with outside status, hidden reasoning and preserved history", () => {
    const f = fixture([response(), update("first")], {
      showReasoning: false, statusPlacement: "outside", preserveMessageHistory: true, activity: false,
    });
    f.view.render();
    const row = f.messagesList.children[0]!;
    const bubble = row.querySelector(".message-bubble")!;
    expect(bubble.hidden).toBe(false);
    expect(bubble.querySelector(".conversation-progress")).not.toBeNull();
    expect(bubble.querySelector(".thinking-body")).toBeNull();
    expect(row.querySelector(".conversation-status")!.parentElement).toBe(row);
  });

  test.each([true, false])("moves updates from an approval host to its resumed answer (preserveHistory=%s)", (preserveMessageHistory) => {
    const wait = { ...response("Approve the action.", false), id: "approval", kind: "tool_approval_request" };
    const messages = [update("first"), wait, update("second")];
    const f = fixture(messages, { preserveMessageHistory, pendingApproval: true });
    f.view.render();
    const waitingRow = f.messagesList.children.find((node) => node.dataset.messageId === "approval")!;
    expectProgressOrder(waitingRow, ["<p>first</p>", "<p>second</p>"]);
    expect(f.messagesList.children.at(-1)).toBe(f.approval);
    messages.push({ ...response("Approved work finished.", false), id: "resumed" });
    const before = structuredClone(messages);
    f.view.render();
    const resumed = f.messagesList.children.find((node) => node.dataset.messageId === "resumed")!;
    expectProgressOrder(resumed, ["<p>first</p>", "<p>second</p>"]);
    expect(matchingNodes(f.messagesList, ".conversation-progress")).toHaveLength(1);
    expect(f.messagesList.children.at(-1)).toBe(f.approval);
    expect(messages).toEqual(before);
  });

  test("leaves ordinary answer rendering and exact Copy behavior intact without updates", async () => {
    const final = "Ordinary **answer**.\n";
    const f = fixture([response(final, false)]);
    f.view.render();
    expect(matchingNodes(f.messagesList, ".conversation-progress")).toHaveLength(0);
    expect(f.messagesList.querySelector(".conversation-activity")).not.toBeNull();
    f.messagesList.querySelector("button")!.dispatch("click");
    await Promise.resolve();
    expect(f.copyText).toHaveBeenCalledExactlyOnceWith(final);
  });
});
