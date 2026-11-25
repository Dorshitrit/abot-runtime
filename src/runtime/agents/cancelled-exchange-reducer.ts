import type { AgentState, AgentMission } from "./agent-records.js";
import type { AgentStateTransition } from "./state-transition.js";
import type { AgentMailboxRecord } from "./workspace-records.js";
import type { AgentWorkspaceCommand } from "./workspace-commands.js";
import { AgentStateError } from "./state-error.js";
import { addWorkspaceUsage, replaceWorkspaceMission, workspaceTransition } from "./workspace-state.js";

function hasMeasuredStoppedWork(state: AgentState, mission: AgentMission): boolean {
  if (state.invocations.some(call => call.missionId === mission.id && call.status !== "settled")) return false;
  if (state.attempts.some(attempt => attempt.missionId === mission.id && (attempt.status !== "settled" || !attempt.result?.usage))) return false;
  return !state.mailbox.some(exchange => exchange.missionId === mission.id && (exchange.status !== "answered" || !exchange.usage));
}

function canReconcileStoppedExchange(state: AgentState, parent: AgentMission, child: AgentMission, exchange: AgentMailboxRecord): boolean {
  if (parent.status === "cancelled" && child.status === "cancelled") return true;
  if (parent.status !== "cancelled" && parent.status !== "awaiting_user_decision") return false;
  if (exchange.status !== "unknown" || exchange.outcome !== "exhausted") return false;
  if (child.status !== "exhausted") return false;
  return state.changes.some(change => change.agentId === child.agentId && change.missionId === child.id &&
    (change.reason === "agents_budget_stop:agents_token_limit_reached" || change.reason === "agents_budget_stop:agents_model_call_limit_reached"));
}

/** Late stop receipts may complete accounting, never success or execution authority. */
export function reconcileCancelledExchange(state: AgentState,
  command: Extract<AgentWorkspaceCommand, {kind:"reconcile_cancelled_exchange"}>, at: string): AgentStateTransition {
  const exchange = state.mailbox.find(entry => entry.id === command.exchangeId && entry.agentId === command.agentId);
  if (!exchange) throw new AgentStateError("agents_exchange_not_found");
  const unchanged = () => workspaceTransition(state, command.agentId, exchange.missionId, "Cancellation accounting remains unchanged.", true);
  if (exchange.status === "answered") return unchanged();
  const parent = state.missions.find(mission => mission.id === exchange.missionId && mission.agentId === exchange.agentId);
  if (!parent) return unchanged();
  const assignment = state.messages.find(message => message.agentId === exchange.recipientAgentId && message.role === "abot" &&
    message.purpose === "request" && message.source?.agentId === exchange.agentId && message.source.missionId === exchange.missionId &&
    message.source.correlationId === exchange.id);
  const child = assignment && state.missions.find(mission => mission.id === assignment.missionId && mission.agentId === exchange.recipientAgentId);
  if (!child || !canReconcileStoppedExchange(state, parent, child, exchange)) return unchanged();
  if (!hasMeasuredStoppedWork(state, child)) return unchanged();
  const usage = {modelCalls:child.usage.modelCalls,totalTokens:child.usage.totalTokens,attempts:child.usage.attempts,clarificationRounds:child.usage.clarificationRounds};
  const retained = {...exchange,status:"answered" as const,outcome:child.status as "cancelled" | "exhausted",usage,updatedAt:at};
  const next = replaceWorkspaceMission({...state,mailbox:state.mailbox.map(entry => entry.id === exchange.id ? retained : entry)},
    {...parent,updatedAt:at,usage:{...parent.usage,
      modelCalls:addWorkspaceUsage(parent.usage.modelCalls,usage.modelCalls), totalTokens:addWorkspaceUsage(parent.usage.totalTokens,usage.totalTokens),
      attempts:addWorkspaceUsage(parent.usage.attempts,usage.attempts), clarificationRounds:addWorkspaceUsage(parent.usage.clarificationRounds,usage.clarificationRounds)}});
  return workspaceTransition(next, command.agentId, parent.id, "Confirmed stopped child usage retained once in its original parent budget.");
}
