import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only view.
import { createConversationView } from "../../web-ui/app/components/conversation-view.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

class StreamElement extends ContextElement {
  scrollTop = 0;
  scrollHeight = 1200;
  clientHeight = 300;
  open = false;
  inert = false;
  set innerHTML(value: string) { this.textContent = value; }
  get innerHTML() { return this.textContent; }
}

type Message = {
  id: string; role: string; requestId: string; text: string;
  streaming: boolean; thinkingText?: string; kind?: string;
};

function fixture(options: { showReasoning?: boolean; outside?: boolean; sources?: boolean; approval?: boolean } = {}) {
  const documentRoot = {
    activeElement: null as ContextElement | null,
    createElement: (tag: string) => new StreamElement(tag),
  };
  const dom = {
    messagesList: documentRoot.createElement("div"),
    jumpToLatestButton: documentRoot.createElement("button"),
  };
  const current: Message = {
    id: "answer", role: "assistant", requestId: "request-1", text: "", streaming: true,
    ...(options.approval ? { kind: "tool_approval_request" } : {}),
  };
  const messages: Message[] = [
    { id: "older", role: "assistant", requestId: "earlier-request", text: "Earlier answer", streaming: false },
    current,
  ];
  const sourceEvents = options.sources === false ? [] : [{
    type: "event", name: "tool.completed", requestId: current.requestId,
    callId: "search-1", tool: "web_search", eventSequence: 1, ok: true,
    webSources: {
      version: 1, operation: "search", provider: "light",
      sources: [{ url: "https://example.com/article", title: "An article", retrieval: "retrieved", presentation: "content", contentTruncated: false }],
    },
  }];
  const viewport = { setTimeout, clearTimeout, requestAnimationFrame: vi.fn() };
  const view = createConversationView({
    dom, documentRoot, viewport, getMessages: () => messages,
    getActiveRequestId: () => current.requestId,
    getActivityForMessage: (message: Message) => ({ events: message.requestId === current.requestId ? sourceEvents : [] }),
    getPendingApprovals: () => [], createApprovalCard: () => documentRoot.createElement("aside"),
    copyText: vi.fn(), notify: vi.fn(), showContextWindow: false,
    showReasoning: options.showReasoning ?? true,
    statusPlacement: options.outside ? "outside" : "bubble",
  });
  const row = () => dom.messagesList.children.find((node) => node.dataset.messageId === current.id)!;
  const stream = (text: string) => {
    current.thinkingText = text;
    view.scheduleThinkingRender();
    vi.advanceTimersByTime(180);
  };
  view.bind();
  return { view, current, messages, row, stream, dom, documentRoot, sourceEvents, viewport };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("thinking stream rendering", () => {
  test.each([false, true])("preserves source cards, images and other messages from the first thought (approval=%s)", (approval) => {
    const f = fixture({ approval });
    f.view.render();
    const older = f.dom.messagesList.children[0];
    const row = f.row();
    const sources = row.querySelector(".conversation-sources")!;
    const image = sources.querySelector("img")!;
    const link = sources.querySelector("a")!;
    f.documentRoot.activeElement = link;

    for (const text of ["First observation", "First observation, then another step"]) {
      f.stream(text);
      expect(f.dom.messagesList.children[0]).toBe(older);
      expect(f.row()).toBe(row);
      expect(row.querySelector(".conversation-sources")).toBe(sources);
      expect(sources.querySelector("img")).toBe(image);
      expect(f.dom.messagesList.contains(f.documentRoot.activeElement)).toBe(true);
      const reasoning = row.querySelector(".conversation-reasoning")!;
      expect(reasoning.hidden).toBe(false);
      expect(reasoning.querySelector("summary")!.getAttribute("aria-label")).toBe(text);
    }
  });

  test("updates an open disclosure in place and retains the reader's scroll position", () => {
    const f = fixture();
    f.current.thinkingText = "Initial reasoning";
    f.view.render();
    const reasoning = f.row().querySelector(".conversation-reasoning") as StreamElement;
    reasoning.open = true;
    reasoning.dispatch("toggle");
    f.dom.messagesList.scrollTop = 240;
    f.dom.messagesList.dispatch("scroll");
    f.stream("Updated **reasoning**");
    expect(f.row().querySelector(".conversation-reasoning")).toBe(reasoning);
    expect(reasoning.open).toBe(true);
    expect(reasoning.querySelector(".thinking-body")!.textContent).toContain("<strong>reasoning</strong>");
    expect((reasoning.querySelector(".thinking-body") as StreamElement).inert).toBe(false);
    expect(f.dom.messagesList.scrollTop).toBe(240);
  });

  test("continues following the bottom as the reasoning grows", () => {
    const f = fixture();
    f.view.render();
    f.dom.messagesList.scrollHeight = 1500;
    f.stream("New reasoning");
    expect(f.dom.messagesList.scrollTop).toBe(1500);
  });

  test("keeps a historical page in place while thinking updates", () => {
    const f = fixture();
    f.view.setHistoryPager({ hasNewer: () => true, renderControls() {} });
    f.view.render();
    f.dom.messagesList.scrollTop = 130;
    f.stream("New reasoning");
    expect(f.dom.messagesList.scrollTop).toBe(130);
    expect(f.dom.jumpToLatestButton.hidden).toBe(false);
  });

  test("does not render unrelated content when reasoning is hidden", () => {
    const f = fixture({ showReasoning: false });
    f.view.render();
    const row = f.row();
    f.stream("Hidden reasoning");
    expect(f.row()).toBe(row);
    expect(row.querySelector(".conversation-reasoning")).toBeNull();
  });

  test("shows and hides an otherwise empty outside-status bubble with its reasoning", () => {
    const f = fixture({ outside: true, sources: false });
    f.view.render();
    const row = f.row();
    const bubble = row.querySelector(".message-bubble")!;
    expect(bubble.hidden).toBe(true);
    f.stream("Visible reasoning");
    expect(f.row()).toBe(row);
    expect(bubble.hidden).toBe(false);
    f.stream("");
    expect(bubble.hidden).toBe(true);
  });

  test("renders a newly added assistant when thinking arrives before its first view render", () => {
    const f = fixture();
    f.messages.pop();
    f.view.render();
    f.messages.push(f.current);
    f.stream("First thought of the new message");
    expect(f.row().querySelector(".thinking-body")!.textContent).toContain("First thought of the new message");
  });

  test("cancels a queued update when the conversation resets", () => {
    const f = fixture();
    f.current.thinkingText = "Initial reasoning";
    f.view.render();
    const oldReasoning = f.row().querySelector(".thinking-body")!;
    f.current.thinkingText = "Queued update";
    f.view.scheduleThinkingRender();
    f.view.reset();
    f.messages.splice(0, f.messages.length, { id: "new", role: "assistant", requestId: "new-request", text: "Another conversation", streaming: false });
    f.view.render();
    const newRow = f.dom.messagesList.children[0];
    vi.advanceTimersByTime(180);
    expect(f.dom.messagesList.children[0]).toBe(newRow);
    expect(oldReasoning.textContent).toContain("Initial reasoning");
    expect(newRow.textContent).not.toContain("Queued update");
  });

  test("structural activity updates still render new sources", () => {
    const f = fixture({ sources: false });
    f.view.render();
    expect(f.row().querySelector(".conversation-sources")).toBeNull();
    f.sourceEvents.push({
      type: "event", name: "tool.completed", requestId: f.current.requestId,
      callId: "search-new", tool: "web_search", eventSequence: 2, ok: true,
      webSources: { version: 1, operation: "search", provider: "light", sources: [{ url: "https://example.com/new", title: "New source", retrieval: "retrieved", presentation: "content", contentTruncated: false }] },
    });
    f.view.render();
    expect(f.row().querySelector(".conversation-sources")).not.toBeNull();
  });
});
