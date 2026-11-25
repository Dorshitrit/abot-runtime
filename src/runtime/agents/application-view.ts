import { projectAgentBudgetStop } from "./budget-stop-view.js";
import { projectAgentApprovalAttention } from "./approval-attention.js";
import { projectLegacyExhaustionReply } from "./exhaustion-reply.js";
import { agentNeedsNewBudget, pausedChatBlock, conversationBlockMessage } from "./conversation-availability.js";
import { pendingAutomaticQuestion } from "./conversation-intent.js";
import type { AgentState } from "./agent-records.js";
import type { AgentApplicationDetail, AgentApplicationStatus } from "./application-contracts.js";
import { AgentStateError } from "./state-error.js";
export function projectAgentDetail(state:AgentState,agentId:string,busy:boolean,replyingToMessageIds:readonly string[] = []):AgentApplicationDetail {
  const agent=state.agents.find((entry)=>entry.id===agentId);
  if(!agent) throw new AgentStateError("agents_agent_not_found");
  const mission=[...state.missions].reverse().find((entry)=>entry.agentId===agentId)??null;
  const attempts=state.attempts.filter((entry)=>entry.agentId===agentId);
  const current=mission?attempts.filter((entry)=>entry.missionId===mission.id):[];
  const pending=current.find((entry)=>entry.status!=="settled"&&!entry.userResolved);
  let status:AgentApplicationStatus="idle";
  if(agent.status==="archived") status="archived";
  else if(mission?.status==="awaiting_user_decision") status="awaiting_user_decision";
  else if(mission?.status==="active") status=pending?.status==="awaiting_approval"?"awaiting_approval":pending?"working":busy?"thinking":"working";
  else if(mission?.status==="exhausted") status="failed";
  const approvalAttention = mission ? projectAgentApprovalAttention(state, agentId, mission.id) : undefined;
  if (approvalAttention && mission?.status === "active") status = "awaiting_approval";
  const trace=[...state.responsibility].reverse().find((entry)=>entry.agentId===agentId&&entry.missionId===mission?.id);
  const exchange=state.mailbox.find((entry)=>entry.agentId===agentId&&entry.missionId===mission?.id&&entry.status==="pending");
  const activity=mission?.waitingReason??(exchange?`Waiting for ${state.agents.find((entry)=>entry.id===exchange.recipientAgentId)?.definition.name??exchange.recipientAgentId}`:trace?`${trace.accepted?"":"Rejected: "}${trace.plan.reason}`:null);
  const question=mission?.status==="awaiting_user_decision"?[...state.messages].reverse().find((entry)=>entry.missionId===mission.id&&entry.purpose==="question"):undefined;
  const assignment=mission?state.messages.find((entry)=>entry.missionId===mission.id&&entry.source):undefined;
  const parentExchange=question&&assignment?.source?state.mailbox.find((entry)=>entry.id===assignment.source!.correlationId&&entry.agentId===assignment.source!.agentId&&entry.missionId===assignment.source!.missionId&&entry.recipientAgentId===agentId&&entry.status==="pending"):undefined;
  const priorReply=parentExchange?.clarifications?.find((entry)=>entry.questionMessageId===question?.id);
  const peerClarification=parentExchange&&question&&priorReply?.status!=="answered"?{questionMessageId:question.id,exchangeId:parentExchange.id,parentAgentId:parentExchange.agentId,childMissionId:mission!.id}:null;
  const pendingUserQuestionId=mission?pendingAutomaticQuestion(state,mission.id)?.id??null:null;
  const chatBlock = mission && pausedChatBlock(state, mission, replyingToMessageIds);
  const terminalReply = mission?.status === "exhausted" && [...state.messages].reverse().find(message =>
    message.agentId === agentId && message.missionId === mission.id && message.role === "assistant" && message.createdAt === mission.updatedAt);
  const lastRecordedReply = terminalReply && current.some(attempt => terminalReply.id.replace(/^#+/u, "") === "work-result:" + attempt.id);
  const emptyRecordedReply = mission?.status === "exhausted" && state.changes.some(change =>
    change.missionId === mission.id && change.at === mission.updatedAt && change.reason.startsWith("agent_work_result_empty:"));
  const lastUser = mission && [...state.messages].reverse().find(message => message.missionId === mission.id && message.role === "user");
  const unansweredUpdate = lastUser?.correctableAttemptId && !replyingToMessageIds.includes(lastUser.id) &&
    !state.messages.some(message => message.missionId === lastUser.missionId && message.id === `reply:${lastUser.id}`);
  return {agent,status,mission,...(approvalAttention && {approvalAttention}),isDeleting:state.deletingAgentIds.includes(agentId),replyingToMessageIds,peerClarification,pendingUserQuestionId,messages:state.messages.filter((entry)=>entry.agentId===agentId).map((entry)=>projectLegacyExhaustionReply(state,entry)),sessions:state.sessions.filter((entry)=>entry.agentId===agentId),attempts,
    decisions:state.decisions.filter((entry)=>entry.agentId===agentId),responsibility:state.responsibility.filter((entry)=>entry.agentId===agentId),mailbox:state.mailbox.filter((entry)=>entry.agentId===agentId),activity,
    recovery:{...projectAgentBudgetStop(state,mission), ...(unansweredUpdate ? {unansweredUpdateId:lastUser.id} : {}), ...(lastRecordedReply ? {recordedWorkDelivery:"output" as const} : {}), ...(emptyRecordedReply ? {recordedWorkDelivery:"empty" as const} : {}),requiresNewBudget:!!mission&&agentNeedsNewBudget(state,mission.id,replyingToMessageIds),pausedChatBlock:chatBlock && conversationBlockMessage(chatBlock)}};
}
