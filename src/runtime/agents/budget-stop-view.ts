import type { AgentState, AgentMission } from "./agent-records.js";
import type { AgentApplicationDetail } from "./application-contracts.js";

type BudgetView = Pick<AgentApplicationDetail["recovery"], "budgetStopReason" | "budgetStopping" | "budgetSessionId">;
/** Exact system markers survive late accounting; old completions use their original timestamp. */
export function projectAgentBudgetStop(state: AgentState, mission: AgentMission | null): BudgetView {
  if (!mission || !["awaiting_user_decision", "exhausted"].includes(mission.status)) return {};
  const changes = [...state.changes].reverse().filter(change => change.agentId === mission.agentId && change.missionId === mission.id);
  const marker = changes.find(change => change.reason === "agents_budget_stop:agents_token_limit_reached" ||
    change.reason === "agents_budget_stop:agents_model_call_limit_reached");
  const reason = mission.status === "awaiting_user_decision" ? mission.waitingReason : marker?.reason.slice("agents_budget_stop:".length) ??
    changes.find(change => change.at === mission.updatedAt)?.reason;
  if (reason !== "agents_token_limit_reached" && reason !== "agents_model_call_limit_reached") return {};
  const attempts = state.attempts.filter(attempt => attempt.agentId === mission.agentId && attempt.missionId === mission.id);
  const sessionId = attempts.at(-1)?.request.sessionId;
  const owned = sessionId && state.sessions.some(session => session.agentId === mission.agentId && session.sessionId === sessionId);
  return { budgetStopReason: reason, budgetStopping: attempts.some(attempt => attempt.status !== "settled" && !attempt.userResolved),
    ...(owned && { budgetSessionId: sessionId }) };
}
