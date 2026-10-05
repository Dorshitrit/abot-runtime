import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only view.
import { createConversationView } from "../../web-ui/app/components/conversation-view.js";
// @ts-expect-error Browser-only presentation.
import { sparkWorkingStatus } from "../../web-ui/app/lib/spark-chat-presentation.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

class ViewElement extends ContextElement {
  scrollTop = 0;
  set innerHTML(value: string) { this.textContent = value; }
  get innerHTML() { return this.textContent; }
}

function fixture(outside = true) {
  const documentRoot = { createElement: (tag: string) => new ViewElement(tag) };
  const messages = [{ id: "a", role: "assistant", requestId: "r", streaming: true, text: "", createdAt: 1 }];
  const state = { connected: true, events: [] as Record<string, unknown>[], approval: false, artifact: false };
  const dom = { messagesList: documentRoot.createElement("div"), jumpToLatestButton: documentRoot.createElement("button") };
  const activity = documentRoot.createElement("div");
  activity.className = "spark-chat-results"; activity.textContent = "notes.txt";
  const approval = documentRoot.createElement("aside");
  approval.className = "approval-card";
  const view = createConversationView({
    dom, documentRoot, viewport: {}, getMessages: () => messages,
    getActiveRequestId: () => "r", isConnected: () => state.connected,
    getActivityForMessage: () => ({ events: state.events }),
    getPendingApprovals: () => state.approval ? [{}] : [], createApprovalCard: () => approval,
    createActivityView: () => ({ createNode: () => state.artifact ? activity : null, reset() {} }),
    copyText: vi.fn(), notify: vi.fn(), scrollBehavior: { afterRender() {} },
    showContextWindow: false,
    ...(outside ? { statusPlacement: "outside", statusPresentation: sparkWorkingStatus } : {}),
  });
  const render = () => { view.render(); return dom.messagesList.querySelector(".message-row")!; };
  return { dom, state, messages, view, render, activity, approval };
}

describe("SPARK working status placement", () => {
  test("shows work outside the bubble and omits an empty streaming placeholder", () => {
    const f = fixture();
    let row = f.render();
    const status = row.querySelector(".conversation-status")!;
    expect(status.parentElement).toBe(row);
    expect(status.textContent).toBe("SPARK is working…");
    expect(row.querySelector(".message-bubble")!.hidden).toBe(true);

    f.messages[0]!.text = "Here is the first part.";
    row = f.render();
    expect(row.querySelector(".message-bubble")!.hidden).toBe(false);
    expect(row.querySelector(".markdown-body")!.textContent).toContain("Here is the first part.");
    expect(row.querySelector(".conversation-status")!.parentElement).toBe(row);
    f.messages[0]!.streaming = false;
    row = f.render();
    expect(row.querySelector(".conversation-status")).toBeNull();
    expect(row.querySelector(".message-bubble")!.hidden).toBe(false);
  });

  test("keeps files and live approval or disconnected state visible while work has no text", () => {
    const f = fixture(); f.state.artifact = true; f.state.approval = true;
    const row = f.render();
    expect(row.querySelector(".message-bubble")!.hidden).toBe(false);
    expect(row.querySelector(".spark-chat-results")).toBe(f.activity);
    expect(f.dom.messagesList.querySelector(".approval-card")).toBe(f.approval);
    f.state.connected = false; f.view.renderActivityStatus();
    expect(row.querySelector(".conversation-status")!.textContent).toBe("Reconnecting");
    f.state.connected = true;
    f.state.events.push({ requestId: "r", name: "tool.approval.required", executionId: "e", tool: "write_file", eventSequence: 1 });
    f.view.renderActivityStatus();
    expect(row.querySelector(".conversation-status")!.textContent).toBe("Waiting for approval");
  });

  test("ordinary conversations retain their in-bubble status and empty streaming bubble", () => {
    const f = fixture(false);
    const row = f.render(), bubble = row.querySelector(".message-bubble")!;
    expect(bubble.hidden).toBe(false);
    expect(row.querySelector(".conversation-status")!.parentElement).toBe(bubble);
    expect(row.classList.contains("message-status-outside")).toBe(false);
  });
});
