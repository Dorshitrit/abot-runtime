import { describe, expect, test } from "vitest";
// @ts-expect-error Browser-only view has no declaration surface.
import { createConversationView } from "../../web-ui/app/components/conversation-view.js";
import { ContextElement } from "./support/composer-context-window-dom.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

type Event = Record<string, unknown>;
type State = ReturnType<typeof createPlanLifecycleHarness>["state"];
const requestId = "request-1";
const statuses = [
  { role: "planner", phase: "planning", message: "Planning the delegated work...", title: "Planner" },
  { role: "worker", phase: "working", message: "Working on the delegated task...", title: "Worker" },
  { role: "reviewer", phase: "reviewing", message: "Auditing the recorded results...", title: "Reviewer" },
  { role: "supervisor", phase: "resuming", message: "Processing the delegated result...", title: "Supervisor" },
];
const modes = ["live", "restored-streaming", "restored-completed"] as const;
type Mode = typeof modes[number];

function progress(status: typeof statuses[number], eventSequence = 1): Event {
  return { type: "event", name: "runtime.state", stage: status.role, phase: status.phase,
    message: status.message, requestId, sessionId: "session-1", environment: "dev", generation: "one",
    eventSequence, seqNo: eventSequence };
}

async function ingress(events: Event[], mode: Mode) {
  const status = mode === "restored-completed" ? "completed" : "streaming";
  const harness = createPlanLifecycleHarness({ sessionId: "session-1", messages: [
    { id: "answer", role: "assistant", requestId, content: status === "completed" ? "Saved final answer" : "" }],
  requests: [{ requestId, status, events,
    lifecycle: { schemaVersion: 1, requestId, generation: "one", revision: 1, status } }] });
  if (mode === "live") for (const event of events) harness.realtime.handle(event);
  else await harness.conversationSession.openSession("session-1");
  return harness;
}

class ViewElement extends ContextElement {
  scrollTop = 0;
  open = false;
  set innerHTML(value: string) { this.textContent = value; }
  get innerHTML() { return this.textContent; }
}
function nodes(root: ContextElement, selector: string): ContextElement[] {
  return root.children.flatMap((node) => [
    ...(node.matches(selector) ? [node] : []), ...nodes(node, selector),
  ]);
}
function viewFor(state: State) {
  const documentRoot = { createElement: (tag: string) => new ViewElement(tag) };
  const messagesList = documentRoot.createElement("div");
  const view = createConversationView({
    dom: { messagesList, jumpToLatestButton: documentRoot.createElement("button") },
    documentRoot, viewport: {}, getMessages: () => state.messages,
    getActiveRequestId: () => state.activeRequestId, getActivityForMessage: () => ({ events: state.events }),
    getPendingApprovals: () => [], createApprovalCard: () => documentRoot.createElement("aside"),
    copyText: async () => undefined, notify() {}, showContextWindow: false, showReasoning: false,
    scrollBehavior: { afterRender() {} },
  });
  view.render();
  return { view, messagesList };
}

function expectNoGenericRows(root: ContextElement) {
  expect(nodes(root, ".conversation-work-event")).toHaveLength(0);
  for (const { message } of statuses) {
    expect(root.textContent.toLowerCase()).not.toContain(message.slice(0, -3));
  }
}

describe("generic status text without hiding recorded agent chips", () => {
  test.each(statuses.flatMap((status) => modes.map((mode) => ({ ...status, mode }))))(
    "renders the $role chip with no other evidence ($mode)", async (status) => {
      const input = [progress(status)]; const before = structuredClone(input);
      const harness = await ingress(input, status.mode);
      const { messagesList } = viewFor(harness.state);
      const chips = nodes(messagesList, ".conversation-work-role");
      expect(chips.map((chip) => chip.dataset.role)).toEqual([status.role]);
      expect(chips[0]?.querySelector(".conversation-work-role-title")?.textContent).toBe(status.title);
      expect(nodes(messagesList, ".conversation-work-entry")).toHaveLength(0);
      expectNoGenericRows(messagesList);
      const panel = messagesList.querySelector(".conversation-work-panel")!;
      expect(panel).not.toBeNull();
      expect(panel.contains(chips[0]!)).toBe(true);
      expect(panel.hidden).toBe(status.mode === "restored-completed");
      if (status.mode === "restored-completed") {
        messagesList.querySelector(".conversation-work-toggle")!.dispatch("click");
        expect(panel.hidden).toBe(false);
        expect(messagesList.textContent).toContain("Saved final answer");
      }
      expect(harness.state.events).toHaveLength(1);
      expect(input).toEqual(before);
    },
  );

  test.each(modes)("keeps role chronology and deduplicates adjacent same-role headers (%s)", async (mode) => {
    const input = [progress(statuses[0]!, 1), progress(statuses[1]!, 2), progress(statuses[1]!, 3),
      progress(statuses[2]!, 4), progress(statuses[3]!, 5), progress(statuses[1]!, 6)];
    const harness = await ingress(input, mode);
    const { view, messagesList } = viewFor(harness.state);
    const expected = ["planner", "worker", "reviewer", "supervisor", "worker"];
    expect(nodes(messagesList, ".conversation-work-role").map((chip) => chip.dataset.role)).toEqual(expected);
    expectNoGenericRows(messagesList);
    view.render();
    expect(nodes(messagesList, ".conversation-work-role").map((chip) => chip.dataset.role)).toEqual(expected);
    expectNoGenericRows(messagesList);
  });

  test("retains actual errors, authored text and tool details beside the chips", async () => {
    const input = [progress(statuses[1]!, 1), {
      ...progress(statuses[1]!, 2), name: "tool.completed", message: undefined,
      tool: "read_file", executionId: "read-1", executorRole: "worker", ok: true,
      meta: { path: "report.txt", outputPreview: "Recorded tool result" },
    }, { ...progress(statuses[2]!, 3), message: "Checking the requested report" },
    progress(statuses[3]!, 4), { ...progress(statuses[3]!, 5), ok: false, error: "Report unavailable" }];
    const harness = await ingress(input, "live");
    harness.state.messages.push({ id: "authored-update", role: "assistant", kind: "user_interaction", requestId,
      text: statuses[2]!.message, streaming: false, eventSequence: 6 });
    const { messagesList } = viewFor(harness.state);
    expect(nodes(messagesList, ".conversation-work-role").map((chip) => chip.dataset.role))
      .toEqual(["worker", "reviewer", "supervisor"]);
    expect(messagesList.textContent).toContain("Checking the requested report");
    expect(messagesList.textContent).toContain("Report unavailable");
    expect(messagesList.textContent).toContain("Recorded tool result");
    expect(nodes(messagesList, ".conversation-tool")).toHaveLength(1);
    expect(nodes(messagesList, ".conversation-work-message").some((node) => node.textContent.includes(statuses[2]!.message))).toBe(true);
  });
});
