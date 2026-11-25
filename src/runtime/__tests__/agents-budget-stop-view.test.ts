import { expect, test } from "vitest";
import { projectAgentBudgetStop } from "../agents/budget-stop-view.js";
import { delegatedApprovalFixture } from "./support/agents-approval-attention-fixture.js";
// @ts-expect-error Browser-only module.
import { renderAgentTaskState } from "../../web-ui/app/components/agents/conversation.js";
// @ts-expect-error Browser-only module.
import { pausedAgentChatBlock } from "../../web-ui/app/components/agents/recovery.js";

test("a hard budget stop is a system card with the exact saved session, not an assistant reply", () => {
  const { state } = delegatedApprovalFixture();
  const mission = { ...state.missions[1]!, status: "awaiting_user_decision" as const, waitingReason: "agents_token_limit_reached" };
  const sessions = [{ agentId: "child", sessionId: "session-child", purpose: "Research", createdAt: mission.createdAt }];
  const recovery = projectAgentBudgetStop({ ...state, sessions }, mission);
  expect(recovery).toEqual({ budgetStopReason: "agents_token_limit_reached", budgetStopping: true, budgetSessionId: "session-child" });
  const markup = renderAgentTaskState({ status: "awaiting_user_decision", mission, recovery, sessions });
  expect(pausedAgentChatBlock({ status: "awaiting_user_decision", recovery })).toContain("Wait for its final status");
  expect(markup).toContain("System"); expect(markup).toContain("Token limit reached");
  expect(markup).toContain("waiting for its final status"); expect(markup).toContain('data-agent-session="session-child"');
  expect(markup).not.toContain("data-agents-action=\"resume\""); expect(markup).not.toContain("agents-message");
  expect(renderAgentTaskState({ mission, recovery, sessions: [] })).not.toContain("data-agent-session=");
});

test("only the current exhausted mission's recorded reason survives terminal projection", () => {
  const { state } = delegatedApprovalFixture();
  const mission = { ...state.missions[1]!, status: "exhausted" as const, waitingReason: null, updatedAt: new Date().toISOString() };
  const change = { ...state.changes.at(-1)!, agentId: "child", missionId: mission.id, at: mission.updatedAt, reason: "agents_model_call_limit_reached" };
  const completed = { ...state, changes: [...state.changes, change], attempts: state.attempts.map(attempt => ({ ...attempt, status: "settled" as const })) };
  const recovery = projectAgentBudgetStop(completed, mission);
  expect(recovery).toMatchObject({ budgetStopReason: "agents_model_call_limit_reached", budgetStopping: false });
  expect(renderAgentTaskState({ status: "failed", mission, recovery })).toContain("The task ended at its budget limit");
  expect(projectAgentBudgetStop({ ...completed, changes: [...state.changes, { ...change, missionId: "old-task" }] }, mission)).toEqual({});
  expect(projectAgentBudgetStop(completed, { ...mission, status: "active" })).toEqual({});
  expect(projectAgentBudgetStop({ ...completed, changes: [...state.changes, { ...change, reason: "A different failure" }] }, mission)).toEqual({});
});

test("the exact system stop marker survives later accounting without matching similar prose", () => {
  const { state } = delegatedApprovalFixture();
  const mission = { ...state.missions[1]!, status: "exhausted" as const, waitingReason: null, updatedAt: new Date().toISOString() };
  const marker = { ...state.changes.at(-1)!, agentId: "child", missionId: mission.id, reason: "agents_budget_stop:agents_token_limit_reached" };
  const later = { ...marker, reason: "Late ordinary usage retained.", at: mission.updatedAt };
  const attempts = state.attempts.map(attempt => ({ ...attempt, status: "settled" as const }));
  const retained = { ...state, attempts, changes: [...state.changes, marker, later] };
  expect(projectAgentBudgetStop(retained, mission)).toMatchObject({ budgetStopReason: "agents_token_limit_reached", budgetStopping: false });
  expect(projectAgentBudgetStop({ ...retained, changes: [{ ...marker, reason: marker.reason + " maybe" }, later] }, mission)).toEqual({});
});
