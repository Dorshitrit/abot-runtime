import { describe, expect, test } from "vitest";
// @ts-expect-error Browser-only view.
import { createConversationView } from "../../web-ui/app/components/conversation-view.js";
import { ContextElement } from "./support/composer-context-window-dom.js";
import { buildConversationRoleCards } from "../../web-ui/app/lib/conversation-role-model.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

const events = [
  { type: "event", name: "runtime.state", requestId: "request-1", stage: "supervisor", phase: "working", presentationRole: "execution_agent", eventSequence: 1 },
  { type: "event", name: "tool.started", requestId: "request-1", executorRole: "supervisor", executionId: "tool-1", tool: "inspect_target", presentationRole: "execution_agent", eventSequence: 2 },
  { type: "event", name: "tool.completed", requestId: "request-1", executorRole: "supervisor", executionId: "tool-1", tool: "inspect_target", presentationRole: "execution_agent", eventSequence: 3, ok: true },
  { type: "event", name: "runtime.state", requestId: "request-1", stage: "reviewer", phase: "reviewing", presentationRole: "auditor", eventSequence: 4 },
];
const cards = (input: unknown[]) => buildConversationRoleCards({ requestId: "request-1", events: input, streaming: false });

describe("recorded Execution Agent and Auditor presentation", () => {
  test("live statuses and tools preserve canonical roles while presenting explicit names", () => {
    const h = createPlanLifecycleHarness();
    events.forEach((event) => h.realtime.handle(event));
    const result = cards(h.state.events);
    expect(result.map(({ role, title }) => ({ role, title }))).toEqual([
      { role: "supervisor", title: "Execution Agent" }, { role: "reviewer", title: "Auditor" },
    ]);
    expect(result[0]?.responsibility).toBe("Handles the request and tools");
    expect(result[1]?.responsibility).toBe("Audits the result");
    expect(result[0]?.toolActions?.[0]).toMatchObject({ executorRole: "supervisor", presentationRole: "execution_agent" });
    expect(h.state.events.map((event) => event.presentationRole)).toEqual(["execution_agent", "execution_agent", "execution_agent", "auditor"]);
  });

  test("reloaded request events keep the same attribution without a selected profile", async () => {
    const live = createPlanLifecycleHarness();
    events.forEach((event) => live.realtime.handle(event));
    const h = createPlanLifecycleHarness({
      sessionId: "session-1", messages: [{ role: "assistant", id: "answer", requestId: "request-1", content: "Done." }],
      requests: [{ requestId: "request-1", status: "completed", finalState: { status: "completed", output: "Done." },
        events: events.map((event, index) => ({ ...event, seqNo: index + 1, timestamp: 1000 + index })) }],
    });
    await h.conversationSession.openSession("session-1");
    expect(cards(h.state.events)).toEqual(cards(live.state.events));
  });

  test("explicit tool executor presentation works without a preceding status", () => {
    const h = createPlanLifecycleHarness();
    h.realtime.handle(events[1]);
    expect(cards(h.state.events)[0]).toMatchObject({ role: "supervisor", title: "Execution Agent" });
  });

  test("legacy SUPER events and invalid or mismatched presentation retain their existing labels", () => {
    const h = createPlanLifecycleHarness();
    h.realtime.handle({ ...events[0], presentationRole: undefined });
    h.realtime.handle({ ...events[3], presentationRole: "execution_agent" });
    expect(cards(h.state.events).map((card) => card.title)).toEqual(["Supervisor", "Reviewer"]);
    expect(h.state.events.every((event) => !Object.hasOwn(event, "presentationRole"))).toBe(true);
    const missing = createPlanLifecycleHarness();
    missing.realtime.handle({ ...events[0], stage: undefined, presentationRole: "execution_agent" });
    expect(cards(missing.state.events)).toEqual([]);
  });
});


test("the rendered blocked work timeline stays open with Execution Agent and Auditor attribution", () => {
  class ViewElement extends ContextElement {
    scrollTop = 0;
    open = false;
    set innerHTML(value: string) { this.textContent = value; }
    get innerHTML() { return this.textContent; }
  }
  const documentRoot = { createElement: (tag: string) => new ViewElement(tag) };
  const messagesList = documentRoot.createElement("div");
  const inputEvents = [...events, { type: "completed", requestId: "request-1", eventSequence: 5, disposition: "blocked" }];
  const view = createConversationView({
    dom: { messagesList, jumpToLatestButton: documentRoot.createElement("button") },
    documentRoot, viewport: {},
    getMessages: () => [{ id: "answer", role: "assistant", requestId: "request-1", text: "Could not finish.", streaming: false }],
    getActiveRequestId: () => "",
    getActivityForMessage: () => ({ events: inputEvents }),
    getPendingApprovals: () => [], createApprovalCard: () => documentRoot.createElement("aside"),
    copyText: async () => undefined, notify: () => {},
    showContextWindow: false, showReasoning: false,
    scrollBehavior: { afterRender() {} },
  });
  view.render();
  const panel = messagesList.querySelector(".conversation-work-panel")!;
  expect(panel.hidden).toBe(false);
  expect(panel.textContent).toContain("Execution Agent");
  expect(panel.textContent).toContain("Auditor");
  expect(panel.textContent).toContain("Request blocked");
  expect(panel.textContent).not.toContain("Supervisor");
  expect(panel.textContent).not.toContain("Reviewer");
  expect(panel.textContent).not.toContain("Response ready");
});
