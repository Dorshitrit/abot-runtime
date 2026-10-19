import { describe, expect, test } from "vitest";
import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import { createConversationRoleCards } from "../../web-ui/app/components/conversation-role-cards.js";
import { enrichEventPayload } from "../events/event-status.js";
import { ContextElement } from "./support/composer-context-window-dom.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

type Event = Record<string, unknown>;

function skillEvent(message: string, eventSequence: number): Event {
  return {
    type: "event", name: "runtime.state", stage: "supervisor", phase: "skills",
    requestId: "request-1", sessionId: "session-1", message, eventSequence,
  };
}

async function activity(events: Event[], enriched = false, replay = false) {
  const wireEvents = events.map((event) => enriched ? enrichEventPayload(event) : event);
  const before = JSON.stringify(wireEvents);
  const savedSession = {
    sessionId: "session-1",
    messages: [{ id: "answer", role: "assistant", content: "Saved answer", requestId: "request-1" }],
    requests: [{
      requestId: "request-1", status: "completed", events: wireEvents,
      finalState: { status: "completed", output: "Saved answer" },
    }],
  };
  const harness = createPlanLifecycleHarness(replay ? savedSession : {});
  if (replay) await harness.conversationSession.openSession("session-1");
  else for (const event of wireEvents) harness.realtime.handle(event);
  const model = buildConversationActivityModel({ requestId: "request-1", events: harness.state.events });
  const documentRoot = {
    createElement: (tag: string) => new ContextElement(tag),
  } as unknown as Document;
  const node = createConversationRoleCards({ documentRoot }).createNode({
    requestId: "request-1", cards: model.roleCards,
    timeline: documentRoot.createElement("div"), hasTimeline: model.events.length > 0,
  }) as unknown as ContextElement;
  expect(JSON.stringify(wireEvents)).toBe(before);
  return { model, node, rows: descendants(node, "conversation-role-skill-activity") };
}

function descendants(node: ContextElement, className: string): ContextElement[] {
  return node.children.flatMap((child) => [
    ...(child.classList.contains(className) ? [child] : []),
    ...descendants(child, className),
  ]);
}

describe("Supervisor Skill activity in agent cards", () => {
  test.each([
    [false, false], [true, false], [false, true], [true, true],
  ])("keeps both reads visible across context events (enriched=%s, replay=%s)", async (enriched, replay) => {
    const { model, node, rows } = await activity([
      skillEvent("Read Skills: Skill Creator", 10),
      { ...skillEvent("", 11), name: "context.window.snapshot", stage: "context_window", phase: "pre_provider" },
      { ...skillEvent("", 12), name: "context.window.provider_usage", stage: "context_window", phase: "provider_completed" },
      skillEvent("Read Skills: Technical Work", 13),
      { ...skillEvent("Planning The Delegated Work", 14), stage: "planner", phase: "planning" },
    ], enriched, replay);

    expect(rows.map((row) => row.textContent)).toEqual([
      "Read Skills: Skill Creator", "Read Skills: Technical Work",
    ]);
    expect(rows.every((row) => row.getAttribute("dir") === "auto")).toBe(true);
    const supervisor = model.roleCards.find((card) => card.role === "supervisor")!;
    expect(supervisor.summary).toBe("");
    expect(supervisor.skillActivities?.map((item) => item.summary)).toEqual(rows.map((row) => row.textContent));
    expect(supervisor.toolActions).toEqual([]);
    expect(model.toolCount).toBe(0);
    expect(model.toolActions).toEqual([]);
    expect(model.events).toHaveLength(3);
    expect(model.eventCount).toBe(3);
    expect(node.textContent.match(/Read Skills: Technical Work/g)).toHaveLength(1);
    expect(node.textContent).toContain("Planning The Delegated Work");
  });

  test.each([false, true])("retains later generic status without replacing read history (replay=%s)", async (replay) => {
    const { model, node, rows } = await activity([
      skillEvent("Read Skills: Skill Creator", 10),
      skillEvent("Read Skills: Technical Work", 11),
      { ...skillEvent("Processing The Delegated Result", 12), phase: "resuming" },
    ], true, replay);
    expect(rows).toHaveLength(2);
    expect(model.roleCards[0]!.summary).toBe("Processing The Delegated Result");
    expect(node.querySelector(".conversation-role-action")?.textContent).toBe("Processing The Delegated Result");
    expect(node.textContent).toContain("Skill Creator");
    expect(node.textContent).toContain("Technical Work");
  });

  test.each([false, true])("deduplicates replay identity but retains separate repeated reads (replay=%s)", async (replay) => {
    const first = skillEvent("Read Skills: Technical Work", 10);
    const { model, rows } = await activity([
      first, { ...first, seqNo: 3 },
      skillEvent("Read Skills: Technical Work", 11),
    ], true, replay);
    expect(rows.map((row) => row.textContent)).toEqual([
      "Read Skills: Technical Work", "Read Skills: Technical Work",
    ]);
    expect(model.events).toHaveLength(1);
    expect(model.events[0]!.count).toBe(2);
    expect(model.eventCount).toBe(2);
    expect(model.toolCount).toBe(0);
  });

  test("preserves a combined read and comma-containing name as one activity", async () => {
    const summary = "Read Skills: Review (Code, Tests), Technical Work";
    const { rows } = await activity([skillEvent(summary, 10)], true);
    expect(rows.map((row) => row.textContent)).toEqual([summary]);
  });

  test.each([false, true])("preserves neutral missing-Skill and actual failure presentation (replay=%s)", async (replay) => {
    const neutral = await activity([
      skillEvent("Read Skills: Technical Work", 10),
      skillEvent("Skill lookup failed: knowledge_skill_not_found", 11),
    ], true, replay);
    expect(neutral.rows[1]!.textContent).toMatch(/^Skill not found$/i);
    expect(neutral.rows[1]!.dataset.tone).toBe("neutral");
    expect(neutral.model.failureCount).toBe(0);
    expect(neutral.node.querySelector(".conversation-role-error")).toBeNull();
    expect(neutral.model.toolCount).toBe(0);

    const failure = await activity([
      skillEvent("Read Skills: Technical Work", 10),
      skillEvent("Skill lookup failed: knowledge_skill_store_unavailable", 11),
    ], true, replay);
    expect(failure.rows[1]!.dataset.tone).toBe("failed");
    expect(failure.model.failureCount).toBe(1);
    expect(failure.node.querySelector(".conversation-role-error")?.textContent).toBe("Activity error");
    expect(failure.model.toolCount).toBe(0);
  });

  test("does not turn Worker Skill tools or another request into Supervisor Skill rows", async () => {
    const worker = {
      ...skillEvent("Worker Read", 11), name: "tool.completed", stage: "worker",
      tool: "abot_skills", ok: true, executionId: "worker-skill-1", executorRole: "worker",
      meta: { skillAction: "read_skill", skillId: "technical-work", skillTitle: "Technical Work" },
    };
    const { model, rows } = await activity([
      skillEvent("Read Skills: Skill Creator", 10),
      { ...worker, name: "tool.started", ok: undefined },
      { ...worker, eventSequence: 12 },
      { ...skillEvent("Read Skills: Other Request", 13), requestId: "request-2" },
    ], true);
    expect(rows.map((row) => row.textContent)).toEqual(["Read Skills: Skill Creator"]);
    expect(model.toolCount).toBe(1);
    expect(model.roleCards.find((card) => card.role === "worker")!.skillActivities).toBeUndefined();
    expect(model.roleCards.find((card) => card.role === "worker")!.toolActions).toHaveLength(1);
  });
});
