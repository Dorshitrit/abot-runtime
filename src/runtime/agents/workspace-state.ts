import type { AgentMission, AgentState } from "./agent-records.js";
import { AgentStateError } from "./state-error.js";
import type { AgentStateTransition } from "./state-transition.js";
export function isAgentMissionOpen(mission: AgentMission): boolean { return mission.status === "active" || mission.status === "awaiting_user_decision"; }
export function requireWorkspaceMission(state: AgentState, agentId: string, missionId: string, active = false): AgentMission {
  const mission = state.missions.find((entry) => entry.id === missionId);
  const agent = state.agents.find((entry) => entry.id === agentId);
  if (!agent || agent.status !== "active") throw new AgentStateError("agents_agent_not_active");
  if (!mission || mission.agentId !== agentId) throw new AgentStateError("agents_mission_owner_mismatch");
  if (active && mission.status !== "active") throw new AgentStateError("agents_mission_not_active");
  return mission;
}
export function workspaceTransition(state: AgentState, agentId: string, missionId: string, reason: string, unchanged = false): AgentStateTransition {
  return { state, kind: "agent_workspace_changed", missionId, reason, unchanged };
}
export function replaceWorkspaceMission(state: AgentState, mission: AgentMission): AgentState {
  return { ...state, missions: state.missions.map((entry) => entry.id === mission.id ? mission : entry) };
}
export function hasUnresolvedAgentWork(state: AgentState, missionId: string): boolean {
  return state.attempts.some((attempt) => attempt.missionId === missionId && attempt.status !== "settled" && !attempt.userResolved);
}
export function hasUnmeasuredAgentWork(state: AgentState, missionId: string): boolean {
  return state.attempts.some((attempt) => attempt.missionId === missionId && attempt.status === "settled" && attempt.result?.usage === null && !attempt.userResolved);
}
export function requireAgentWorkAllowance(state: AgentState, mission: AgentMission): void {
  if (hasUnresolvedAgentWork(state, mission.id)) throw new AgentStateError("agents_work_unresolved");
  if (hasUnmeasuredAgentWork(state, mission.id)) throw new AgentStateError("agents_work_usage_unknown");
  if (state.mailbox.some((entry) => entry.missionId === mission.id && (entry.status !== "answered" || entry.outcome === null))) throw new AgentStateError("agents_exchange_unresolved");
  if (mission.usage.attempts >= mission.limits.maxAttempts) throw new AgentStateError("agents_attempt_limit_reached");
  if (mission.usage.modelCalls >= mission.limits.maxModelCalls) throw new AgentStateError("agents_model_call_limit_reached");
  if (mission.usage.totalTokens >= mission.limits.maxTotalTokens) throw new AgentStateError("agents_token_limit_reached");
  if (mission.usage.consecutiveNoProgress >= mission.limits.maxConsecutiveNoProgress) throw new AgentStateError("agents_no_progress_limit_reached");
}
export function addWorkspaceUsage(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new AgentStateError("agents_usage_overflow");
  return total;
}
