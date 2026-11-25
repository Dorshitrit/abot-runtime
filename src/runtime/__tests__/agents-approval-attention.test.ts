import { expect, test } from "vitest";
import { projectAgentDetail } from "../agents/application-view.js";
import { projectAgentApprovalAttention } from "../agents/approval-attention.js";
import { delegatedApprovalFixture } from "./support/agents-approval-attention-fixture.js";

test("a parent exposes exact nested pending approval targets, never unrelated agents or tool details", () => {
  const { state } = delegatedApprovalFixture();
  const detail = projectAgentDetail(state, "parent", false);
  expect(detail.status).toBe("awaiting_approval");
  expect(detail.approvalAttention).toEqual({ totalTargets: 2, targets: [
    { agentId: "child", agentName: "child", missionId: "mission-child" },
    { agentId: "grandchild", agentName: "grandchild", missionId: "mission-grandchild" },
  ] });
  expect(JSON.stringify(detail.approvalAttention)).not.toContain("other");
  expect(detail.attempts).toEqual([]);
});

test("resume and cancellation remove the approval signal without finishing the parent task", () => {
  const { state } = delegatedApprovalFixture();
  const running = { ...state, attempts: state.attempts.map(attempt => ({ ...attempt, status: "running" as const })) };
  expect(projectAgentDetail(running, "parent", false)).toMatchObject({ status: "working", mission: { status: "active" } });
  expect(projectAgentDetail(running, "parent", false).approvalAttention).toBeUndefined();
  const cancelled = { ...state, missions: state.missions.map(mission => mission.agentId === "child"
    ? { ...mission, status: "cancelled" as const } : mission) };
  expect(projectAgentDetail(cancelled, "parent", false).approvalAttention).toBeUndefined();
});

test("old, ambiguous or foreign delegation bindings cannot expose a different task's approval", () => {
  const { state } = delegatedApprovalFixture();
  for (const change of [
    { mailbox: state.mailbox.map(exchange => ({ ...exchange, status: "answered" as const })) },
    { deletingAgentIds: ["child"] },
    { messages: state.messages.filter(message => message.agentId !== "child") },
    { messages: [...state.messages, { ...state.messages.find(message => message.agentId === "child")!, id: "ambiguous" }] },
    { missions: [...state.missions, { ...state.missions.find(mission => mission.agentId === "child")!, id: "new-child-task" }] },
  ]) expect(projectAgentApprovalAttention({ ...state, ...change }, "parent", "mission-parent")).toBeUndefined();
  expect(projectAgentApprovalAttention(state, "other", "mission-other")?.targets.map(target => target.agentId)).toEqual(["other"]);
});

test("projection stays bounded while reporting omitted targets explicitly", () => {
  const { state } = delegatedApprovalFixture();
  const children = Array.from({ length: 52 }, (_, index) => `child-${index}`);
  const expanded = { ...state,
    agents: [state.agents[0]!, ...children.map(id => ({ ...state.agents[1]!, id, definition: { ...state.agents[1]!.definition, name: id } }))],
    missions: [state.missions[0]!, ...children.map(id => ({ ...state.missions[1]!, id: `mission-${id}`, agentId: id }))],
    mailbox: children.map(id => ({ ...state.mailbox[0]!, id: `exchange-${id}`, recipientAgentId: id })),
    messages: children.map(id => ({ ...state.messages[1]!, id: `message-${id}`, agentId: id, missionId: `mission-${id}`,
      source: { agentId: "parent", missionId: "mission-parent", correlationId: `exchange-${id}` } })),
    attempts: children.map(id => ({ ...state.attempts[0]!, id: `attempt-${id}`, agentId: id, missionId: `mission-${id}` })),
  };
  const attention = projectAgentApprovalAttention(expanded, "parent", "mission-parent")!;
  expect(attention.totalTargets).toBe(52); expect(attention.targets).toHaveLength(50);
  for (const target of attention.targets) expect(Object.keys(target).sort()).toEqual(["agentId", "agentName", "missionId"]);
});

test("a terminal cancellation receipt removes stale approval attention while the parent is still active", () => {
  const { state } = delegatedApprovalFixture();
  const settled = { ...state, attempts: state.attempts.map(attempt => ({ ...attempt, status: "settled" as const })) };
  expect(projectAgentDetail(settled, "parent", false)).toMatchObject({ status: "working", mission: { status: "active" } });
  expect(projectAgentDetail(settled, "parent", false).approvalAttention).toBeUndefined();
  const resolved = { ...state, attempts: state.attempts.map(attempt => ({ ...attempt, userResolved: true })) };
  expect(projectAgentDetail(resolved, "child", false).status).toBe("working");
  expect(projectAgentDetail(resolved, "child", false).approvalAttention).toBeUndefined();
});
