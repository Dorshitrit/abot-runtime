import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser presentation module.
import { createSparkChatResults } from "../../web-ui/app/components/spark-chat/results.js";
// @ts-expect-error Browser presentation module.
import { sparkConversationMessages, sparkMessageStatus, sparkWorkingStatus } from "../../web-ui/app/lib/spark-chat-presentation.js";
// @ts-expect-error Browser-only view.
import { createConversationView } from "../../web-ui/app/components/conversation-view.js";
import { syncChatgptPlanIndicator } from "../../web-ui/app/components/chatgpt-plan-indicator.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

class ViewElement extends ContextElement {
  scrollTop = 0;
  set innerHTML(value: string) { this.textContent = value; }
  get innerHTML() { return this.textContent; }
}
const documentRoot = { createElement: (tag: string) => new ViewElement(tag) };
const update = (sequence: number, text = `Update ${sequence}`, requestId = "r") => ({
  id: `update-${requestId}-${sequence}`, role: "assistant", kind: "user_interaction",
  requestId, text, eventSequence: sequence, streaming: false,
});
function harness() {
  return createSparkChatResults({ documentRoot });
}

describe("SPARK friendly presentation", () => {
  test("shows the shared plan notice by the composer and removes stale visibility without duplicate elements", () => {
    const root = new ContextElement("div");
    const anchor = new ContextElement("form"); root.append(anchor);
    const options = { anchor: anchor as unknown as HTMLElement, documentRoot: { createElement: (tag: string) => new ContextElement(tag) } as unknown as Document };
    syncChatgptPlanIndicator({ ...options, usingPlan: false });
    expect(root.querySelector(".chatgpt-plan-indicator")).toBeNull();
    syncChatgptPlanIndicator({ ...options, usingPlan: true });
    const note = root.querySelector(".chatgpt-plan-indicator")!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain("Using ChatGPT plan");
    expect((note.querySelector("a") as unknown as HTMLAnchorElement).href).toBe("https://chatgpt.com/settings/usage");
    syncChatgptPlanIndicator({ ...options, usingPlan: true });
    expect(root.children).toHaveLength(2);
    syncChatgptPlanIndicator({ ...options, usingPlan: false });
    expect(note.hidden).toBe(true);
  });

  test("keeps composer feedback but hides every per-message technical status", () => {
    expect(sparkMessageStatus("ABot response completed.")).toBe("");
    expect(sparkMessageStatus("ABot is working.")).toBe("");
    expect(sparkMessageStatus("File upload failed: connection lost")).toBe("File upload failed: connection lost");
    expect(sparkMessageStatus("Waiting for your approval.")).toBe("Waiting for your approval.");
    expect(sparkMessageStatus("Message queued for this conversation.")).toBe("Message queued for this conversation.");
    for (const model of [null, { label: "Running tool", animate: true }, { label: "Tool approval", animate: false }])
      expect(sparkWorkingStatus(model)).toBeNull();
  });

  test("renders only scoped, ordered, deduplicated EA updates using shared safe message styling", () => {
    const results = harness();
    const updates = [update(2), update(1, "שלום **עדכון** <script>alert(1)</script>"), update(2), update(3, "Other request", "other")];
    const before = structuredClone(updates);
    const node = results.createNode({ requestId: "r", updates });
    expect(results.handlesProgressUpdates).toBe(true);
    expect(node.children).toHaveLength(2);
    expect(node.children.every((child: ContextElement) => child.matches(".conversation-work-message"))).toBe(true);
    expect(node.children[0].textContent).toContain("<strong>עדכון</strong>");
    expect(node.children[0].textContent).toContain("&lt;script&gt;");
    expect(node.children[0].textContent).not.toContain("<script>");
    expect(node.children[0].classList.contains("rtl-text")).toBe(true);
    expect(node.children[1].textContent.trim()).toBe("<p>Update 2</p>");
    expect(node.textContent).not.toContain("Other request");
    expect(node.textContent).not.toContain("Progress updates");
    expect(updates).toEqual(before);
    results.reset();
    expect(results.createNode({ requestId: "r" })).toBeNull();
  });

  test("hides all tool, source, file, warning, failure and lifecycle events", () => {
    const results = harness();
    const fileOutput = { version: 1, location: "agent_work", rootId: `sha256:${"a".repeat(64)}`, relativePath: "notes.txt", logicalPath: "notes.txt", operation: "created" };
    const events = [
      { requestId: "r", name: "tool.completed", executionId: "file", tool: "write_file", ok: true, meta: { fileOutput } },
      { requestId: "r", name: "tool.completed", executionId: "web", tool: "web_search", ok: true, webSources: { version: 1, operation: "search", sources: [{ url: "https://example.com/read", title: "Read this", retrieval: "retrieved", presentation: "content", contentTruncated: false }] } },
      { requestId: "r", name: "tool.failed", executionId: "f", tool: "read_file", error: "The file is unavailable" },
      { requestId: "r", name: "Attachment warning", tone: "warning", summary: "Image could not be attached" },
      { requestId: "r", name: "request.completed" },
      { requestId: "other", name: "Failure", tone: "failed", summary: "Other conversation" },
    ];
    expect(results.createNode({ requestId: "r", events })).toBeNull();
    const node = results.createNode({ requestId: "r", events, updates: [update(1)] });
    expect(node.textContent.trim()).toBe("<p>Update 1</p>");
    for (const selector of [".conversation-activity", ".conversation-tool-file-action", ".conversation-source-link", ".spark-result-warning"])
      expect(node.querySelector(selector)).toBeNull();
  });

  test("keeps progress, final answer and separate approval controls through live completion", async () => {
    const messages = [
      { id: "answer", role: "assistant", requestId: "r", text: "", streaming: true },
      update(1),
      { id: "approval", role: "assistant", requestId: "r", kind: "tool_approval_request", text: "Tool approval required.", streaming: false },
    ];
    const dom = { messagesList: documentRoot.createElement("div"), jumpToLatestButton: documentRoot.createElement("button") };
    const approval = documentRoot.createElement("aside");
    approval.className = "pending-approval-card";
    const copyText = vi.fn(async () => undefined);
    const view = createConversationView({
      dom, documentRoot, viewport: {}, getMessages: () => sparkConversationMessages(messages),
      getActiveRequestId: () => "r", getActivityForMessage: () => ({ events: [] }),
      getPendingApprovals: () => [{}], createApprovalCard: () => approval,
      copyText, notify() {}, createActivityView: createSparkChatResults,
      statusPresentation: sparkWorkingStatus, statusPlacement: "outside",
      showReasoning: false, showContextWindow: false, preserveMessageHistory: true,
      scrollBehavior: { afterRender() {} },
    });
    view.render();
    expect(dom.messagesList.querySelector(".conversation-work-message")).not.toBeNull();
    expect(dom.messagesList.querySelector(".conversation-progress")).toBeNull();
    expect(dom.messagesList.querySelector(".message-approval-presentation")).toBeNull();
    expect(dom.messagesList.querySelector(".conversation-status")?.hidden).toBe(true);
    expect(dom.messagesList.children.at(-1)).toBe(approval);
    const final = "**Exact final**\n\nKeep this spacing.  \n";
    messages[0] = { ...messages[0]!, text: final, streaming: false };
    const before = structuredClone(messages);
    view.render();
    expect(dom.messagesList.textContent).toContain("<strong>Exact final</strong>");
    expect(dom.messagesList.textContent).not.toContain("Tool approval required.");
    expect(dom.messagesList.querySelector(".conversation-work-message")).not.toBeNull();
    expect(dom.messagesList.children.at(-1)).toBe(approval);
    dom.messagesList.querySelector("button")!.dispatch("click");
    await Promise.resolve();
    expect(copyText).toHaveBeenCalledExactlyOnceWith(final);
    expect(messages).toEqual(before);
    view.reset();
  });
});
