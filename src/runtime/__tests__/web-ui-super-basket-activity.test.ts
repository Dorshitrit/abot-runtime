import { expect, test } from "vitest";
import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import { createConversationRoleCards } from "../../web-ui/app/components/conversation-role-cards.js";
import { projectRoleDelegationEvent } from "../../web-ui/app/lib/role-delegation-event.js";
import { enrichEventPayload } from "../events/event-status.js";
import { ContextElement } from "./support/composer-context-window-dom.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

type Event = Record<string, unknown>;
const PRIVATE = "PRIVATE_SOURCE_BODY_QUERY_OUTPUT";
const NAME = 'תכנית <img src=x onerror="bad()">';
const phases = [
  ["discovery_found", "matched"], ["search_started", "started"], ["search_completed", "completed"],
  ["search_unavailable", "unavailable"], ["read_started", "started"], ["read_completed", "completed"],
  ["read_unavailable", "unavailable"],
] as const;

function stage(stage: string, sequence: number, extra: Event = {}): Event {
  return {
    type: "event", name: "runtime.state", requestId: "request-1", sessionId: "session-1",
    eventSequence: sequence, stage, phase: "working", message: "Working on the request.", ...extra,
  };
}

function basket(phase: string, sequence: number, message = "Information basket activity.", extra: Event = {}): Event {
  return stage("information_basket", sequence, { phase, message, ...extra });
}

function delegation(extra: Event = {}): Event {
  return {
    type: "event", name: "role.delegated", requestId: "request-1",
    sessionId: "session-1", generation: "generation-1", eventSequence: 1,
    callerCallId: "call-1", callerRole: "supervisor", childCallId: "call-2",
    childRole: "planner", objective: "Prepare the requested research.", ...extra,
  };
}

function descendants(node: ContextElement, className: string): ContextElement[] {
  return node.children.flatMap(child => [
    ...(child.classList.contains(className) ? [child] : []), ...descendants(child, className),
  ]);
}

async function activity(events: Event[], replay = false, streaming = false) {
  const wire = events.map(event => enrichEventPayload(event));
  const before = JSON.stringify(wire);
  const saved = {
    sessionId: "session-1",
    messages: [{ id: "answer", role: "assistant", content: "Saved answer", requestId: "request-1" }],
    requests: [{ requestId: "request-1", status: "completed", events: wire,
      finalState: { status: "completed", output: "Saved answer" } }],
  };
  const harness = createPlanLifecycleHarness(replay ? saved : {});
  if (replay) await harness.conversationSession.openSession("session-1");
  else for (const event of wire) harness.realtime.handle(event);
  const model = buildConversationActivityModel({ requestId: "request-1", events: harness.state.events, streaming });
  const documentRoot = { createElement: (tag: string) => new ContextElement(tag) } as unknown as Document;
  const timeline = documentRoot.createElement("div");
  timeline.textContent = "TIMELINE_ONLY";
  const node = createConversationRoleCards({ documentRoot }).createNode({
    requestId: "request-1", cards: model.roleCards, timeline, hasTimeline: model.events.length > 0,
  }) as unknown as ContextElement;
  const supervisorNode = descendants(node, "conversation-role-card").find(card => card.dataset.role === "supervisor");
  const rows = supervisorNode ? descendants(supervisorNode, "conversation-basket-activity") : [];
  expect(JSON.stringify(wire)).toBe(before);
  return { model, node, supervisorNode, rows };
}

test.each([false, true])("SUPER keeps independent basket statuses inside its card (replay=%s)", async replay => {
  const messages = [
    "Found 2 relevant information basket sources: plan_v2.md, notes.txt.",
    "Searching information basket.",
    "Found 1 relevant information basket source: plan_v2.md.",
    "Information basket search unavailable.",
    "Reading information basket source: plan_v2.md.",
    "Read information basket source: plan_v2.md.",
    "Information basket source read unavailable.",
  ];
  const { model, supervisorNode, rows } = await activity([
    stage("supervisor", 1), ...phases.map(([phase], index) => basket(phase, index + 2, messages[index]!)),
  ], replay);
  expect(rows.map(row => row.querySelector(".conversation-basket-label")!.textContent)).toEqual(messages);
  expect(rows.map(row => row.dataset.status)).toEqual(phases.map(([, status]) => status));
  expect(supervisorNode!.querySelector(".conversation-basket-collection")!.getAttribute("aria-label"))
    .toBe("Information basket activity");
  expect(supervisorNode!.textContent).not.toContain("TIMELINE_ONLY");
  expect(model.roleCards.find(card => card.role === "supervisor")!.basketActivities)
    .toEqual(phases.map(([phase, status], index) => ({ phase, status, label: messages[index] })));
  expect(model.toolCount).toBe(0);
  expect(model.toolActions).toEqual([]);
  expect(rows).toHaveLength(7);
});

test.each([false, true])("deduplicates event identity while retaining order and separate repeated reads (replay=%s)", async replay => {
  const first = basket("read_completed", 10, "Read information basket source: first.txt.");
  const second = basket("read_completed", 11, "Read information basket source: second.txt.");
  const { model, rows } = await activity([
    second, first, { ...first, seqNo: 99 },
    basket("read_completed", 12, "Read information basket source: first.txt."),
    basket("read_completed", 13, "OTHER_REQUEST", { requestId: "request-2" }),
  ], replay);
  expect(rows.map(row => row.querySelector(".conversation-basket-label")!.textContent))
    .toEqual([first.message, second.message, first.message]);
  expect(model.roleCards.find(card => card.role === "supervisor")!.basketActivities).toHaveLength(3);
  expect(rows.some(row => row.textContent.includes("OTHER_REQUEST"))).toBe(false);
  expect(model.toolCount).toBe(0);
});

test.each([false, true])("discovery waits for positive SUPER identity and unknown phases create no basket rows (replay=%s)", async replay => {
  const discovery = basket("discovery_found", 1, "Found 1 relevant information basket source: plan.md.");
  expect((await activity([discovery], replay)).rows).toEqual([]);
  const superRun = await activity([
    discovery, stage("supervisor", 2, { phase: "skills", message: "Read Skills: Information Basket" }),
  ], replay);
  expect(superRun.rows).toHaveLength(1);
  const unknown = await activity([
    stage("supervisor", 1), basket("read_failed_unknown", 2, "UNKNOWN_PHASE"),
  ], replay);
  expect(unknown.rows).toEqual([]);
  expect(unknown.model.roleCards.find(card => card.role === "supervisor")!.basketActivities ?? []).toEqual([]);
});

test.each([false, true])("EA resuming status does not establish SUPER ownership of passive discovery (replay=%s)", async replay => {
  const { model, node, rows } = await activity([
    basket("discovery_found", 1, "Found 1 relevant information basket source: plan.md."),
    stage("supervisor", 2, { phase: "resuming", message: "Processing the completed tool result." }),
  ], replay);
  expect(rows).toEqual([]);
  expect(descendants(node, "conversation-basket-collection")).toEqual([]);
  expect(model.roleCards.find(card => card.role === "supervisor")!.basketActivities ?? []).toEqual([]);
  expect(model.toolCount).toBe(0);
});

test.each([false, true])("committed SUPER delegation owns passive discovery without Skills or source reads (replay=%s)", async replay => {
  const assigned = delegation();
  expect(projectRoleDelegationEvent(assigned)).toMatchObject({
    callerCallId: "call-1", callerRole: "supervisor", childCallId: "call-2", childRole: "planner",
  });
  const label = "Found 1 relevant information basket source: plan.md.";
  const { model, rows, supervisorNode } = await activity([
    assigned, basket("discovery_found", 2, label), stage("planner", 3),
  ], replay);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.querySelector(".conversation-basket-label")!.textContent).toBe(label);
  expect(rows[0]!.dataset.status).toBe("matched");
  expect(supervisorNode!.querySelector(".conversation-basket-collection")).not.toBeNull();
  const supervisor = model.roleCards.find(card => card.role === "supervisor")!;
  expect(supervisor.basketActivities).toEqual([{ phase: "discovery_found", status: "matched", label }]);
  expect(supervisor.delegations).toHaveLength(1);
  expect(supervisor.skillActivities ?? []).toEqual([]);
  expect(supervisor.toolActions).toEqual([]);
  expect(model.toolCount).toBe(0);
});

test.each([false, true])("invalid or another request's delegation cannot claim passive sources (replay=%s)", async replay => {
  for (const overrides of [
    { callerRole: "worker" }, { childCallId: "" }, { objective: "" }, { requestId: "request-2" },
  ]) {
    const assigned = delegation(overrides);
    if (overrides.requestId === undefined) expect(projectRoleDelegationEvent(assigned)).toBeNull();
    const { model, rows, node } = await activity([
      assigned, basket("discovery_found", 2, "Found 1 relevant information basket source: plan.md."),
    ], replay);
    expect(rows).toEqual([]);
    expect(descendants(node, "conversation-basket-collection")).toEqual([]);
    expect(model.roleCards.find(card => card.role === "supervisor")?.basketActivities ?? []).toEqual([]);
    expect(model.toolCount).toBe(0);
  }
});

test.each([false, true])("a terminal request does not turn a recorded start into Running or a synthetic completion (replay=%s)", async replay => {
  const { model, rows, supervisorNode } = await activity([
    stage("supervisor", 1),
    basket("read_started", 2, "Reading information basket source: unfinished.txt."),
    { type: "completed", name: "request.completed", requestId: "request-1", sessionId: "session-1",
      eventSequence: 3, output: "Saved answer" },
  ], replay);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.dataset.status).toBe("started");
  expect(rows[0]!.querySelector(".conversation-basket-status")!.textContent).toBe("Started");
  expect(supervisorNode!.textContent).not.toContain("Running");
  expect(supervisorNode!.querySelector(".conversation-role-active")).toBeNull();
  expect(model.roleCards.find(card => card.role === "supervisor")!.active).toBe(false);
  expect(model.toolCount).toBe(0);
});

test.each([false, true])("unavailable results stay distinct from completed and actual failed activity (replay=%s)", async replay => {
  const { model, rows, supervisorNode } = await activity([
    basket("search_completed", 1, "No relevant information basket sources found."),
    basket("search_unavailable", 2, "Information basket search unavailable."),
    basket("read_unavailable", 3, "Information basket source read unavailable."),
  ], replay);
  expect(rows.map(row => row.dataset.status)).toEqual(["completed", "unavailable", "unavailable"]);
  expect(model.failureCount).toBe(0);
  expect(supervisorNode!.querySelector(".conversation-role-error")).toBeNull();
  const failure = await activity([
    basket("read_unavailable", 1, "Information basket source read unavailable."),
    stage("supervisor", 2, { phase: "failed", message: "Execution failed.", status: "failed" }),
  ], replay);
  expect(failure.rows[0]!.dataset.status).toBe("unavailable");
  expect(failure.model.failureCount).toBeGreaterThan(0);
  expect(failure.supervisorNode!.querySelector(".conversation-role-error")).not.toBeNull();
});

test.each(phases)("basket %s preserves the active Worker owner for legacy tools", async (phase) => {
  const { model, rows } = await activity([
    stage("supervisor", 1, { phase: "skills", message: "Read Skills: Information Basket" }), stage("worker", 2),
    stage("worker", 3, { name: "tool.started", stage: undefined, tool: "read_file", message: undefined }),
    basket(phase, 4),
    stage("worker", 5, { name: "tool.completed", stage: undefined, tool: "read_file", message: undefined, ok: true }),
  ], false, true);
  expect(rows).toHaveLength(1);
  const worker = model.roleCards.find(card => card.role === "worker")!;
  expect(worker.toolActions).toHaveLength(1);
  expect(worker.active).toBe(true);
  expect(model.roleCards.find(card => card.role === "supervisor")!.toolActions).toEqual([]);
  expect(model.toolCount).toBe(1);
  expect(model.toolActions).toHaveLength(1);
});

test.each([false, true])("EA discovery and ordinary basket tools do not create duplicate SUPER basket rows (replay=%s)", async replay => {
  const read = stage("supervisor", 3, {
    name: "tool.completed", tool: "information_basket", ok: true, executionId: "ea-read",
    executorRole: "supervisor", meta: { basketAction: "read_information_source", itemCount: 1, documentName: "plan.md" },
  });
  const { model, rows, node } = await activity([
    basket("discovery_found", 1, "Found 1 relevant information basket source: plan.md."),
    { ...read, name: "tool.started", eventSequence: 2, ok: undefined }, read,
  ], replay);
  expect(rows).toEqual([]);
  expect(descendants(node, "conversation-basket-collection")).toEqual([]);
  expect(model.toolCount).toBe(1);
  expect(model.toolActions).toHaveLength(1);
  expect(model.toolActions[0]!.title).toBe("Read information source");
  expect(model.roleCards.flatMap(card => card.toolActions ?? [])).toHaveLength(1);
});

test.each([false, true])("labels use only bounded status text and render source names as plain text (replay=%s)", async replay => {
  const poison = { query: PRIVATE, output: PRIVATE, error: PRIVATE, body: PRIVATE, path: PRIVATE,
    meta: { query: PRIVATE, outputPreview: PRIVATE, inputPreview: PRIVATE } };
  const { model, rows, supervisorNode } = await activity([
    basket("read_completed", 1, "Read information basket source: " + NAME + ".", poison),
    basket("search_started", 2, "", poison),
    basket("search_completed", 3, "Found 9 relevant sources: " + "😀".repeat(900), poison),
  ], replay);
  const activities = model.roleCards.find(card => card.role === "supervisor")!.basketActivities!;
  expect(activities.every(item => Array.from(item.label).length <= 800)).toBe(true);
  expect(JSON.stringify(activities)).not.toContain(PRIVATE);
  expect(rows.some(row => row.textContent.includes(NAME))).toBe(true);
  expect(rows.every(row => !row.textContent.includes(PRIVATE))).toBe(true);
  expect(supervisorNode!.querySelector("img")).toBeNull();
  expect(supervisorNode!.querySelector("script")).toBeNull();
});
