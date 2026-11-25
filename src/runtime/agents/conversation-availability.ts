import type { AgentMission, AgentState } from "./agent-records.js";
import { conversationInvocationId, initialAgentMessage } from "./conversation-intent.js";
import { hasUnresolvedAgentWork } from "./workspace-state.js";

/** Only the application which is still authoring the exact reply can account for a live reservation. */
export function agentNeedsNewBudget(state: AgentState, missionId: string, replyingTo: readonly string[] = []): boolean {
  const unsettled = state.invocations.some((record) => {
    if (record.missionId !== missionId || record.status === "settled") return false;
    if (record.status === "usage_unknown") return true;
    return !replyingTo.some((id) => record.id === conversationInvocationId(missionId, id, record.agentRevision, record.missionRevision));
  });
  const paused = state.missions.some(mission => mission.id === missionId && mission.status === "awaiting_user_decision");
  return unsettled ||
    (paused && state.attempts.some(entry => entry.missionId === missionId && entry.status !== "settled" && !entry.userResolved)) ||
    state.attempts.some((entry) => entry.missionId === missionId && (entry.status === "unknown" || entry.status === "settled" && entry.result?.usage === null)) ||
    state.mailbox.some((entry) => entry.missionId === missionId && (entry.status !== "answered" || entry.outcome === null)) ||
    state.mailbox.some((entry) => entry.clarifications?.some((item) => item.childMissionId === missionId && item.status === "unknown"));
}

const conversationBlocks = {
  agents_chat_needs_resolution: "The outcome or cost of earlier work is unconfirmed. Review the task before sending another message.",
  agents_work_unresolved: "A work session is still outstanding. Review its status before starting another reply.",
  agents_exchange_allowance_reserved: "The remaining allowance is reserved for an active Agent exchange.",
  agents_peer_clarification_pending: "An Agent exchange is using the task’s remaining allowance.",
  agents_model_call_limit_reached: "This task has used all of its model calls.",
  agents_token_limit_reached: "This task has too few tokens left for another reply.",
  agents_no_progress_limit_reached: "This task has reached its limit on attempts without progress.",
  agents_context_capacity_exceeded: "This message exceeds the available conversation context.",
  agents_chat_requires_recovery: "Use Continue conversation to review the previous reply first.",
  agents_mission_not_active: "This task closed before the agent could reply."
};
type ConversationBlock = keyof typeof conversationBlocks;

export function conversationBlockMessage(code: string): string | null {
  return Object.hasOwn(conversationBlocks, code) ? conversationBlocks[code as ConversationBlock] : null;
}

/** Checked again inside the durable reservation. Chat has no right to resume work or borrow an allowance. */
export function pausedChatBlock(state: AgentState, mission: AgentMission, replyingTo: readonly string[] = []): ConversationBlock | null {
  if (mission.status !== "awaiting_user_decision") return null;
  if (initialAgentMessage(state, mission.id)?.purpose === "conversation") return "agents_chat_requires_recovery";
  if (state.mailbox.some((entry) => entry.clarifications?.some((c) => c.childMissionId === mission.id && c.status === "reserved"))) return "agents_peer_clarification_pending";
  if (agentNeedsNewBudget(state, mission.id, replyingTo)) return "agents_chat_needs_resolution";
  if (hasUnresolvedAgentWork(state, mission.id)) return "agents_work_unresolved";
  if (mission.usage.modelCalls >= mission.limits.maxModelCalls) return "agents_model_call_limit_reached";
  if (mission.usage.totalTokens >= mission.limits.maxTotalTokens) return "agents_token_limit_reached";
  if (mission.usage.consecutiveNoProgress >= mission.limits.maxConsecutiveNoProgress) return "agents_no_progress_limit_reached";
  return null;
}
