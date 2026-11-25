import { expect, test } from "vitest";
import { projectAgentDetail } from "../agents/application-view.js";
import { remoteAgentSummary } from "../agents/remote-workspace-view.js";
import { delegatedApprovalFixture } from "./support/agents-approval-attention-fixture.js";
import type { SessionStore } from "../ports.js";
import type { RemoteAgentCommand } from "../agents/remote-workspace-input.js";
// @ts-expect-error Browser-only module.
import { pendingAgentApprovalTargets, renderAgentApprovalTray, renderDelegatedApprovalAttention } from "../../web-ui/app/components/agents/approval-attention.js";
// @ts-expect-error Browser-only module.
import { currentOrbitNotice } from "../../web-ui/app/components/agents/orbit-notices.js";
// @ts-expect-error Browser-only module.
import { renderAgentButton } from "../../web-ui/app/components/agents/appearance.js";

function fixture() {
  const target = { agentId: "child", agentName: "Research <safe>", missionId: "child-task" };
  const parent = { id: "parent", status: "active", workStatus: "awaiting_approval", mission: { id: "parent-task", status: "active" },
    definition: { name: "Parent" }, approvalAttention: { targets: [target], totalTargets: 1 } };
  const child = { ...parent, id: "child", mission: { id: "child-task", status: "active" } };
  return { parent, child, target };
}

test("the visible approval tray deduplicates parent-child attention and opens the actual child", () => {
  const { parent, child } = fixture();
  expect(pendingAgentApprovalTargets([parent, child])).toHaveLength(1);
  const tray = renderAgentApprovalTray([parent, child]);
  expect(tray).toContain('data-agent-id="child"'); expect(tray).not.toContain('data-agent-id="parent"');
  expect(tray).toContain("Research &lt;safe&gt;"); expect(tray).toContain("Waiting for your approval");
  expect(renderAgentApprovalTray([parent, { ...child, mission: { id: "new-task", status: "active" } }])).toBe("");
  expect(renderAgentApprovalTray([parent, { ...child, mission: { id: "child-task", status: "cancelled" } }])).toBe("");
});

test("parent conversation and orbit both expose the approval without granting from the parent", () => {
  const { parent, child } = fixture();
  const markup = renderDelegatedApprovalAttention({ ...parent, agent: { id: "parent" } });
  expect(markup).toContain('data-agent-id="child"'); expect(markup).not.toContain("data-agent-approval=");
  expect(currentOrbitNotice(parent)).toMatchObject({ kind: "approval", text: "Research <safe> needs your approval" });
  expect(renderAgentButton(child, 0)).toContain("needs-approval");
  expect(renderAgentButton(child, 0)).not.toContain("is-working");
  expect(currentOrbitNotice({ ...parent, mission: { status: "cancelled" } })).toBeNull();
});

test("a delegated hard stop remains a canonical system tray row while the parent chat is open", async () => {
  const { state } = delegatedApprovalFixture();
  const stopped = { ...state, missions: state.missions.map(mission => mission.agentId === "child" ? { ...mission, status: "exhausted" as const } : mission),
    attempts: state.attempts.map(attempt => ({ ...attempt, status: "settled" as const })),
    changes: [...state.changes, { ...state.changes.at(-1)!, agentId: "child", missionId: "mission-child", reason: "agents_budget_stop:agents_token_limit_reached" }] };
  const catalog = await Promise.all(["parent", "child"].map(id => remoteAgentSummary(projectAgentDetail(stopped, id, false),
    { local: true } as RemoteAgentCommand, {} as SessionStore)));
  const tray = renderAgentApprovalTray(catalog);
  expect(tray).toContain("System · Token limit reached");
  expect(tray).toContain('data-agent-id="child"'); expect(tray).not.toContain("data-agent-approval=");
  expect(tray).not.toContain("agents-message");
  expect(renderAgentApprovalTray(catalog.map(agent => ({ ...agent, mission: { id: "new", status: "active" } })))).toBe("");
});
