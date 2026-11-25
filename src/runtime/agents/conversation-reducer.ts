import type { AgentMission, AgentState } from "./agent-records.js";
import type { AgentConversationMessage } from "./workspace-records.js";
import { agentNeedsNewBudget } from "./conversation-availability.js";
import type { AgentWorkspaceCommand } from "./workspace-commands.js";
import { conversationInvocationId, correctableAgentAttempt, initialAgentMessage, unansweredConversationMessages } from "./conversation-intent.js";
import { reserveBoundConversationReply } from "./invocation-reducer.js";
import { AgentStateError } from "./state-error.js";
import { hasUnresolvedAgentWork, replaceWorkspaceMission, requireWorkspaceMission, workspaceTransition } from "./workspace-state.js";

type ReplyCommand = Extract<AgentWorkspaceCommand, {kind:"reserve_conversation_reply"|"publish_conversation_reply"}>;

/** A follow-up admitted while work was active may still use its original allowance for a reply. */
function completedFollowUp(state: AgentState, mission: AgentMission, source: AgentConversationMessage, agentRevision: number) {
  if (mission.status !== "completed" || !source.correctableAttemptId) return false;
  const attempt = state.attempts.find(entry => entry.id === source.correctableAttemptId);
  if (attempt?.agentId !== mission.agentId || attempt.missionId !== mission.id || attempt.status !== "settled" || !attempt.result?.usage ||
      attempt.userResolved || attempt.agentRevision !== agentRevision || attempt.missionRevision + 1 !== mission.revision ||
      hasUnresolvedAgentWork(state, mission.id) || agentNeedsNewBudget(state, mission.id)) return false;
  const priorId = conversationInvocationId(mission.id, source.id, agentRevision, attempt.missionRevision);
  if (state.invocations.some(entry => entry.id === priorId)) throw new AgentStateError("agents_conversation_already_claimed");
  return true;
}

export function reduceConversationReply(state: AgentState, command: ReplyCommand, at: string) {
  const mission = requireWorkspaceMission(state, command.agentId, command.missionId);
  const source = state.messages.find((message) => message.id === command.messageId && message.agentId === command.agentId && message.missionId === mission.id);
  if (source?.role !== "user" || source.purpose !== "conversation") throw new AgentStateError("agents_conversation_source_invalid");
  const replyId = `reply:${source.id}`;
  const agentRevision = state.agents.find((agent) => agent.id === command.agentId)!.revision;
  const expectedId = conversationInvocationId(mission.id, source.id, agentRevision, mission.revision);
  if (command.kind === "reserve_conversation_reply") {
    const completed = completedFollowUp(state, mission, source, agentRevision);
    const prior = completed && command.missionRevision + 1 === mission.revision;
    if ((command.missionRevision !== mission.revision && !prior) || command.agentRevision !== agentRevision ||
        command.invocationId !== conversationInvocationId(mission.id, source.id, agentRevision, command.missionRevision))
      throw new AgentStateError("agents_conversation_revision_changed");
    if (state.invocations.some((entry) => entry.id === expectedId) || state.messages.some((entry) => entry.id === replyId)) throw new AgentStateError("agents_conversation_already_claimed");
    const {messageId: _messageId, kind: _kind, ...reservation} = command;
    return reserveBoundConversationReply(state, reservation, at, completed);
  }
  const receipt = command.invocationId && state.invocations.find(entry => entry.id === command.invocationId);
  if (command.invocationId && (!receipt || receipt.agentId !== command.agentId || receipt.missionId !== mission.id ||
      receipt.stage !== "authoring" || receipt.status !== "settled" ||
      command.invocationId !== conversationInvocationId(mission.id,source.id,receipt.agentRevision,receipt.missionRevision))) {
    throw new AgentStateError("agents_conversation_receipt_invalid");
  }
  if (command.withdrawAttemptId && (!receipt || command.withdrawAttemptId !== source.correctableAttemptId))
    throw new AgentStateError("agents_conversation_withdrawal_invalid");
  const existing = state.messages.find((message) => message.id === replyId);
  if (existing) {
    if (existing.agentId !== command.agentId || existing.missionId !== mission.id || existing.role !== "assistant" || existing.text !== command.text) throw new AgentStateError("agents_message_identity_conflict");
    return workspaceTransition(state, command.agentId, mission.id, "Reply already retained.", true);
  }
  const standalone = initialAgentMessage(state, mission.id)?.purpose === "conversation";
  if ((standalone && mission.status !== "active") || (mission.status === "cancelled" && !(source.correctableAttemptId && receipt)))
    return workspaceTransition(state, command.agentId, mission.id, "Conversation disposition retained.", true);
  if (standalone && command.invocationId && command.invocationId !== expectedId)
    return workspaceTransition(state, command.agentId, mission.id, "Conversation authority changed.", true);
  // Settlement may race this reply. Only the admitted attempt and an unchanged user turn can withdraw the task.
  const withdraw = command.withdrawAttemptId && command.invocationId === expectedId && correctableAgentAttempt(state, mission, source);
  const reply = {id:replyId,agentId:command.agentId,missionId:mission.id,role:"assistant" as const,purpose:"reply" as const,source:null,text:command.text,createdAt:at,
    ...(withdraw ? {withdrawnAttemptId:withdraw.id} : {})};
  let next: AgentState = {...state, messages:[...state.messages,reply]};
  if (withdraw) {
    next = replaceWorkspaceMission(next, {...mission, status:"cancelled", waitingReason:null, revision:mission.revision + 1, updatedAt:at});
  } else if (standalone && unansweredConversationMessages(next, mission.id).length === 0) {
    next = replaceWorkspaceMission(next, {...mission, status:command.invocationId?"completed":"exhausted", waitingReason:null, revision:mission.revision + 1, updatedAt:at});
  }
  return workspaceTransition(next, command.agentId, mission.id, "Conversation reply retained.");
}
