import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only view.
import { createConversationView } from "../../web-ui/app/components/conversation-view.js";
// @ts-expect-error Browser-only presentation.
import { sparkConversationMessages, sparkWorkingStatus } from "../../web-ui/app/lib/spark-chat-presentation.js";
// @ts-expect-error Browser-only presentation.
import { createSparkChatResults } from "../../web-ui/app/components/spark-chat/results.js";
import { createToolApprovalCard } from "../../web-ui/app/components/tool-approval-card.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

class ViewElement extends ContextElement {
  scrollTop = 0;
  set innerHTML(value: string) { this.textContent = value; }
  get innerHTML() { return this.textContent; }
}

function fixture(outside = true) {
  const documentRoot = { createElement: (tag: string) => new ViewElement(tag) };
  const messages: Record<string, unknown>[] = [{ id: "a", role: "assistant", requestId: "r", streaming: true, text: "", createdAt: 1 }];
  const state = { connected: true, events: [] as Record<string, unknown>[], approval: false };
  const dom = { messagesList: documentRoot.createElement("div"), jumpToLatestButton: documentRoot.createElement("button") };
  const onDecision = vi.fn();
  const approval = createToolApprovalCard({
    event: { approvalId: "approval-1", tool: "write_file" },
    documentRoot: documentRoot as unknown as Document, onDecision,
  }) as unknown as ViewElement;
  const view = createConversationView({
    dom, documentRoot, viewport: {}, getMessages: () => outside ? sparkConversationMessages(messages) : messages,
    getActiveRequestId: () => "r", isConnected: () => state.connected,
    getActivityForMessage: () => ({ events: state.events }),
    getPendingApprovals: () => state.approval ? [{}] : [], createApprovalCard: () => approval,
    createActivityView: outside ? createSparkChatResults : () => ({ createNode: () => null, reset() {} }),
    copyText: vi.fn(), notify: vi.fn(), scrollBehavior: { afterRender() {} },
    showContextWindow: false,
    ...(outside ? { statusPlacement: "outside", statusPresentation: sparkWorkingStatus } : {}),
  });
  const render = () => { view.render(); return dom.messagesList.querySelector(".message-row")!; };
  return { dom, state, messages, view, render, approval, onDecision };
}

describe("SPARK working status placement", () => {
  test("hides technical status and empty streaming placeholders while preserving updates and final text", () => {
    const f = fixture();
    let row = f.render();
    const status = row.querySelector(".conversation-status")!;
    expect(status.parentElement).toBe(row);
    expect(status.hidden).toBe(true);
    expect(status.textContent).toBe("");
    expect(row.querySelector(".message-bubble")!.hidden).toBe(true);

    f.messages.push({
      id: "update", role: "assistant", requestId: "r", kind: "user_interaction",
      text: "I am checking the relevant source.", eventSequence: 1,
    });
    row = f.render();
    expect(row.querySelector(".message-bubble")!.hidden).toBe(false);
    expect(row.querySelector(".conversation-work-message")!.textContent).toContain("I am checking the relevant source.");
    expect(row.querySelector(".conversation-progress")).toBeNull();

    f.messages[0]!.text = "Here is the first part.";
    row = f.render();
    expect(row.querySelector(".message-bubble")!.hidden).toBe(false);
    expect(row.textContent).toContain("Here is the first part.");
    expect(row.querySelector(".conversation-status")!.parentElement).toBe(row);
    expect(row.querySelector(".conversation-status")!.hidden).toBe(true);
    f.messages[0]!.streaming = false;
    row = f.render();
    expect(row.querySelector(".conversation-status")).toBeNull();
    expect(row.querySelector(".message-bubble")!.hidden).toBe(false);
  });

  test("hides file and technical connection events while keeping actionable approval separate", () => {
    const f = fixture(); f.state.approval = true;
    f.state.events.push({
      requestId: "r", name: "tool.completed", executionId: "e", tool: "write_file", ok: true,
      meta: { fileOutput: { version: 1, location: "agent_work", rootId: `sha256:${"a".repeat(64)}`, relativePath: "notes.txt", logicalPath: "notes.txt", operation: "created" } },
    });
    f.messages.push({
      id: "approval", role: "assistant", requestId: "r", kind: "tool_approval_request", text: "Tool approval required.",
    });
    const row = f.render();
    expect(row.querySelector(".message-bubble")!.hidden).toBe(true);
    expect(row.querySelector(".spark-chat-results")).toBeNull();
    expect(f.dom.messagesList.textContent).not.toContain("notes.txt");
    expect(f.dom.messagesList.querySelector(".message-approval-presentation")).toBeNull();
    expect(f.dom.messagesList.querySelector(".approval-message-row")).toBe(f.approval);
    f.state.connected = false; f.view.renderActivityStatus();
    expect(row.querySelector(".conversation-status")!.hidden).toBe(true);
    expect(row.querySelector(".conversation-status")!.textContent).toBe("");
    f.state.connected = true;
    f.state.events.push({ requestId: "r", name: "tool.approval.required", executionId: "e", tool: "write_file", eventSequence: 1 });
    f.view.renderActivityStatus();
    expect(row.querySelector(".conversation-status")!.hidden).toBe(true);
    expect(row.querySelector(".conversation-status")!.textContent).toBe("");
    f.approval.querySelector(".approve")!.dispatch("click");
    expect(f.onDecision).toHaveBeenCalledExactlyOnceWith("approval-1", true);
  });

  test("ordinary conversations retain their in-bubble status and empty streaming bubble", () => {
    const f = fixture(false);
    const row = f.render(), bubble = row.querySelector(".message-bubble")!;
    expect(bubble.hidden).toBe(false);
    expect(row.querySelector(".conversation-status")!.parentElement).toBe(bubble);
    expect(row.classList.contains("message-status-outside")).toBe(false);
  });
});
