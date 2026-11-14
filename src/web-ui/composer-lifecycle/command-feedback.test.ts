import { expect, test, vi } from "vitest";
import { ContextElement } from "../../runtime/__tests__/support/composer-context-window-dom.js";
import { createRealtimeContextHarness } from "../../runtime/__tests__/support/realtime-context-harness.js";
// @ts-expect-error Browser view.
import { createConversationView } from "../app/components/conversation-view.js";
// @ts-expect-error Browser command state.
import { latestCommandRun } from "../app/lib/command-runs.js";

class ChatElement extends ContextElement {
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 300;
  open = false;
  set innerHTML(value: string) {
    this.textContent = value;
  }
  get innerHTML() {
    return this.textContent;
  }
  get nextSibling(): ContextElement | null {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  insertBefore(child: ContextElement, next: ContextElement | null) {
    const siblings = child.parentElement?.children;
    if (siblings) siblings.splice(siblings.indexOf(child), 1);
    child.parentElement = this;
    this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, child);
    return child;
  }
}

function fixture() {
  const f = createRealtimeContextHarness();
  f.state.messages = [];
  f.state.activeRequestId = "";
  const messages = f.state.messages as Array<(typeof f.state.messages)[number] & { createdAt?: number }>;
  const documentRoot = {
    activeElement: null,
    createElement: (tag: string) => new ChatElement(tag),
  };
  const messagesList = documentRoot.createElement("section");
  const view = createConversationView({
    dom: {
      messagesList,
      jumpToLatestButton: documentRoot.createElement("button"),
    },
    documentRoot,
    viewport: { setTimeout, clearTimeout, requestAnimationFrame: vi.fn() },
    getMessages: () => messages,
    getActiveRequestId: () => f.state.activeRequestId,
    getCommandRun: () =>
      latestCommandRun(f.state, {
        environmentId: "environment-1",
        sessionId: "session-1",
      }),
    getActivityForMessage: () => ({ events: f.state.events }),
    getPendingApprovals: () => [],
    emptyState: { render: (container: ChatElement) => container.replaceChildren() },
    showContextWindow: false,
    createApprovalCard: vi.fn(),
    copyText: vi.fn(),
    notify: vi.fn(),
  });
  f.renderActivityStatus.mockImplementation(() => {
    view.renderActivityStatus();
    return {} as any;
  });
  return { ...f, view, messagesList, messages };
}

const started = {
  type: "event", name: "command.started", requestKind: "command",
  command: { name: "compact", mode: "run" },
  sessionId: "session-1", requestId: "command-1", seqNo: 1,
  timestamp: "2026-11-09T20:00:00.000Z",
};
const completed = {
  ...started, type: "completed", name: "context.compaction.completed",
  outcome: "compacted", seqNo: 2, timestamp: "2026-11-09T20:00:01.000Z",
};
function message(id: string, offset: number, role = "assistant") {
  return { id, role, requestId: id, text: id, streaming: false, createdAt: Date.parse(started.timestamp) + offset };
}
function order(f: ReturnType<typeof fixture>) {
  return f.messagesList.children.filter(node => !node.hidden).map(node => node.dataset.messageId || "command");
}

test.each(["completed", "failed"])(
  "command start and %s render in chat and survive rerender without a chat message",
  (type) => {
    const f = fixture();
    f.view.render();
    f.controller.handle(started);
    const status = f.messagesList.querySelector(".conversation-command-status")!;
    expect(status.parentElement).toBe(f.messagesList);
    expect(status.textContent).toContain("Compacting");
    f.controller.handle({ ...completed, type, error: "Provider input-count rejected the format." });
    expect(status.textContent).toContain(type === "failed" ? "/compact failed" : "Conversation history compacted");
    const details = status.querySelector("details") as ChatElement | null;
    if (details) {
      details.open = true;
      expect(details.querySelector("pre")?.textContent).toContain("input-count rejected");
    }
    f.view.render();
    expect(f.messagesList.querySelector(".conversation-command-status")).toBe(status);
    expect(status.querySelector("details")).toBe(details);
    if (details) expect(details.open).toBe(true);
    expect(f.state.messages).toHaveLength(0);
    expect(f.state.requestMessages.has("command-1")).toBe(false);
  },
);

test("command feedback stays between prior history and subsequent turns, including snapshot replay", () => {
  const f = fixture();
  f.messages.push(message("before", -1000));
  f.view.render();
  f.controller.handle(started);
  expect(order(f)).toEqual(["before", "command"]);
  f.controller.handle(completed);
  f.messages.push(message("next-user", 2000, "user"), message("next-answer", 3000));
  f.view.render();
  f.view.renderActivityStatus();
  expect(order(f)).toEqual(["before", "command", "next-user", "next-answer"]);

  const restored = fixture();
  restored.messages.push(...f.messages);
  restored.view.render();
  // Snapshot events use epoch milliseconds; live events may use ISO timestamps.
  restored.controller.recordEvent({ ...started, timestamp: Date.parse(started.timestamp) });
  restored.controller.recordEvent({ ...completed, timestamp: Date.parse(completed.timestamp) });
  restored.view.render();
  expect(order(restored)).toEqual(order(f));
  expect(restored.messagesList.querySelector(".conversation-command-status")?.textContent).toContain("compacted");
});

test("a later command is hidden in an older history window and restored on return", () => {
  const f = fixture();
  f.messages.push(message("before", -1000));
  let newer = true;
  f.view.setHistoryPager({ hasNewer: () => newer, renderControls() {} });
  f.view.render();
  f.controller.handle(completed);
  expect(order(f)).toEqual(["before"]);
  newer = false;
  f.view.render();
  expect(order(f)).toEqual(["before", "command"]);
});
