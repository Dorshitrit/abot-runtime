import { expect, test, vi } from "vitest";
// @ts-expect-error Browser view.
import { createConversationView } from "../../web-ui/app/components/conversation-view.js";
// @ts-expect-error Browser controller.
import { createHistoryPagination } from "../../web-ui/app/controllers/history-pagination.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

class ViewElement extends ContextElement {
  private top = 0;
  get scrollTop() { return this.top; }
  set scrollTop(value: number) {
    const next = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    if (next === this.top) return;
    this.top = next;
    // Browsers dispatch scroll after programmatic positioning too.
    queueMicrotask(() => this.dispatch("scroll"));
  }
  scrollHeight = 1000;
  clientHeight = 200;
  set innerHTML(value: string) { this.textContent = value; }
  get innerHTML() { return this.textContent; }
}

test("rendering a target window keeps it bounded; only Jump to latest fetches the end", async () => {
  const documentRoot = { createElement: (tag: string) => new ViewElement(tag) };
  const dom = { messagesList: documentRoot.createElement("div"), jumpToLatestButton: documentRoot.createElement("button") };
  const viewport = { requestAnimationFrame: vi.fn() };
  const view = createConversationView({
    dom, documentRoot, viewport,
    getMessages: () => [{ id: "old", role: "assistant", text: "", createdAt: 1 }],
    getActivityForMessage: () => ({ events: [] }), showContextWindow: false,
    createActivityView: () => ({ createNode: () => null, reset() {} }),
    notify: vi.fn(),
  });
  let hasNewer = true;
  const latest = vi.fn(async () => { hasNewer = false; });
  view.setHistoryPager({ hasNewer: () => hasNewer, renderControls() {}, latest });
  view.bind(); view.render();
  expect(latest).not.toHaveBeenCalled();
  expect(dom.jumpToLatestButton.hidden).toBe(false);
  dom.jumpToLatestButton.dispatch("click");
  await Promise.resolve();
  expect(latest).toHaveBeenCalledOnce();
});

test.each(["wheel", "touchmove", "pointerdown", "keydown"])("target positioning never fetches pages; %s scrolling fetches one", async (input) => {
  const documentRoot = { createElement: (tag: string) => new ViewElement(tag) };
  const dom = { messagesList: documentRoot.createElement("div"), jumpToLatestButton: documentRoot.createElement("button") };
  const viewport = { requestAnimationFrame: vi.fn() };
  const state = { currentSessionId: "session", sessionViewVersion: 1, messages: [{ id: "old", role: "assistant", text: "", createdAt: 1 }] };
  const view = createConversationView({
    dom, documentRoot, viewport, getMessages: () => state.messages,
    getActivityForMessage: () => ({ events: [] }), showContextWindow: false,
    createActivityView: () => ({ createNode: () => null, reset() {} }), notify: vi.fn(),
  });
  const client = { loadSession: vi.fn(async () => ({ messages: [{ id: "newer", role: "assistant", text: "", createdAt: 2 }], requests: [], newerCursor: "next-newer" })) };
  const history = createHistoryPagination({
    state, dom, client, selectedEnvironmentId: () => "dev", normalizeMessage: (message: unknown) => message,
    onRequests: vi.fn(), renderMessages: view.render, applyReadState: vi.fn(),
    conversationView: { setHistoryPager: view.setHistoryPager, preserveScroll: (change: () => void) => change() },
  });
  history.adopt({ nextCursor: "older", newerCursor: "newer" });
  view.bind(); view.render();
  expect(dom.messagesList.scrollTop).toBe(0);
  expect(viewport.requestAnimationFrame).not.toHaveBeenCalled();
  // Simulate a caller's target positioning, including a position near a page boundary.
  dom.messagesList.scrollTop = 800;
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(client.loadSession).not.toHaveBeenCalled();
  dom.messagesList.dispatch(input, { key: "ArrowDown" });
  dom.messagesList.scrollTop = 790;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(client.loadSession).toHaveBeenCalledExactlyOnceWith("session", "dev", { cursor: "newer" });
  expect(state.messages.map((message) => message.id)).toEqual(["old", "newer"]);
  // A later layout or render scroll must not cause another fetch without input.
  dom.messagesList.scrollTop = 800;
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(client.loadSession).toHaveBeenCalledOnce();
});
