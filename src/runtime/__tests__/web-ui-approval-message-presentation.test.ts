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
function descendants(root: ContextElement): ContextElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}
function fixture(messages: Item[], pending: Item[] = []) {
  const documentRoot = { createElement: (tag: string) => new ViewElement(tag) };
  const messagesList = documentRoot.createElement("div");
  const copyText = vi.fn(async () => undefined);
  const view = createConversationView({
    dom: { messagesList, jumpToLatestButton: documentRoot.createElement("button") },
    documentRoot, viewport: {}, getMessages: () => messages,
    getActiveRequestId: () => "request", getActivityForMessage: () => ({ events: [] }),
    getPendingApprovals: () => pending,
    createApprovalCard: () => {
      const card = documentRoot.createElement("aside");
      card.textContent = "Approve / Reject";
      return card;
    },
    copyText, notify: () => {}, showContextWindow: false, showReasoning: false,
    scrollBehavior: { afterRender() {} },
  });
  return { view, messagesList, copyText };
}
const approval = (state: string): Item => ({
  id: "wait", kind: "tool_approval_request", role: "assistant",
  requestId: "request", text: "Inspect the requested file.", streaming: false,
  approvalRequest: { kind: "tool_approval_request", state },
});

describe("saved approval intent presentation", () => {
  test.each(["pending", "rejected", "approved"])("labels %s approval prose as approval, without a final answer action", (state) => {
    const messages = [approval(state)];
    const before = structuredClone(messages);
    const f = fixture(messages, state === "pending" ? [{}] : []);
    f.view.render();
    const row = f.messagesList.querySelector(".message-approval-presentation")!;
    expect(row.getAttribute("aria-label")).toBe("Tool approval");
    expect(row.textContent).toContain("Inspect the requested file.");
    expect(descendants(row).some((node) => node.getAttribute("aria-label") === "Copy response")).toBe(false);
    if (state === "pending") expect(f.messagesList.textContent).toContain("Approve / Reject");
    expect(messages).toEqual(before);
  });

  test("the continued final answer replaces approval prose and preserves exact Copy", async () => {
    const messages = [approval("approved"), {
      id: "answer", role: "assistant", requestId: "request", text: "Exact answer.", streaming: false,
    }];
    const f = fixture(messages);
    f.view.render();
    expect(f.messagesList.querySelector(".message-approval-presentation")).toBeNull();
    expect(f.messagesList.textContent).not.toContain("Inspect the requested file.");
    const copy = descendants(f.messagesList).find((node) => node.getAttribute("aria-label") === "Copy response")!;
    copy.dispatch("click");
    await Promise.resolve();
    expect(f.copyText).toHaveBeenCalledExactlyOnceWith("Exact answer.");
  });
});
