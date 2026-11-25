import { reconcileCancelledExchange } from "./cancelled-exchange-reducer.js";
import { reduceConversationReply } from "./conversation-reducer.js";
import { activeAgentAttemptForCorrection, pendingAutomaticQuestion, recordedMessageIntent } from "./conversation-intent.js";
import { reduceAgentPeerClarification } from "./peer-clarification-reducer.js";
import { isDeepStrictEqual } from "node:util";
import type { AgentMission, AgentState } from "./agent-records.js";
import type { AgentWorkspaceCommand } from "./workspace-commands.js";
import type { AgentStateTransition } from "./state-transition.js";
import { AgentStateError } from "./state-error.js";
import { isAgentMissionOpen, replaceWorkspaceMission, requireWorkspaceMission, workspaceTransition } from "./workspace-state.js";
import { recordedWorkReplyCommand } from "./workspace-evidence.js";
import { reduceWorkspaceWork } from "./workspace-work-reducer.js";
import { reduceWorkspacePlan } from "./workspace-plan-reducer.js";
import { reduceWorkspaceMailbox } from "./workspace-mailbox-reducer.js";

function openTurn(state:AgentState,command:Extract<AgentWorkspaceCommand,{kind:"open_agent_turn"}>,at:string):AgentStateTransition {
  const existing=state.messages.find((entry)=>entry.id===command.messageId);
  if(existing) {
    if(existing.agentId!==command.agentId||existing.text!==command.text||recordedMessageIntent(existing)!==command.intent||!isDeepStrictEqual(existing.source,command.source)) throw new AgentStateError("agents_message_identity_conflict");
    return workspaceTransition(state,command.agentId,existing.missionId,"Message already accepted.",true);
  }
  const agent=state.agents.find((entry)=>entry.id===command.agentId);
  if(!agent||agent.status!=="active") throw new AgentStateError("agents_agent_not_active");
  if(command.expectedAgentRevision!==undefined&&agent.revision!==command.expectedAgentRevision) throw new AgentStateError("agents_agent_revision_conflict");
  if ((command.source || command.expectedAgentRevision !== undefined) && command.intent !== "task") throw new AgentStateError("agents_message_invalid");
  const open = state.missions.find((entry) => entry.agentId === agent.id && isAgentMissionOpen(entry));
  if (open) {
    if (["agents_token_limit_reached","agents_model_call_limit_reached"].includes(open.waitingReason ?? "") &&
      state.attempts.some(attempt => attempt.missionId === open.id && attempt.status !== "settled" && !attempt.userResolved))
      throw new AgentStateError("agents_work_unresolved");
    if (command.intent === "task" || command.source) throw new AgentStateError("agents_agent_busy");
    const question = command.intent === "auto" && command.questionId ? pendingAutomaticQuestion(state, open.id) : undefined;
    if (command.questionId && question?.id !== command.questionId) throw new AgentStateError("agents_question_already_answered");
    const next = question ? replaceWorkspaceMission(state, {...open, status:"active", waitingReason:null, revision:open.revision+1, updatedAt:at}) : state;
    const attempt = !question && command.intent === "auto" ? activeAgentAttemptForCorrection(state, open) : undefined;
    const message = {id:command.messageId,agentId:agent.id,missionId:open.id,role:"user" as const,source:null,text:command.text,createdAt:at,
      purpose:question?"clarification" as const:"conversation" as const,...(command.intent==="auto"?{inputIntent:"auto" as const}:{}),...(question?{inReplyTo:question.id}:{}),
      ...(attempt ? {correctableAttemptId:attempt.id} : {})};
    return workspaceTransition({...next,messages:[...next.messages,message]},agent.id,open.id,question?"The user answered the pending clarification.":"User conversation retained.");
  }
  if (command.questionId) throw new AgentStateError("agents_question_already_answered");
  if (!command.limits) throw new AgentStateError("agents_limits_required");
  if(state.missions.some((entry)=>entry.id===command.missionId)) throw new AgentStateError("agents_mission_exists");
  if(command.source) {
    const exchange=state.mailbox.find((entry)=>entry.id===command.source!.correlationId);
    if(!exchange||exchange.agentId!==command.source.agentId||exchange.missionId!==command.source.missionId||exchange.recipientAgentId!==agent.id||exchange.assignment!==command.text||exchange.status!=="pending") throw new AgentStateError("agents_peer_assignment_invalid");
    const parent = state.missions.find((entry) => entry.id === exchange.missionId && entry.agentId === exchange.agentId);
    if (parent?.status !== "active" || parent.revision !== exchange.missionRevision) throw new AgentStateError("agents_peer_assignment_invalid");
  }
  const mission:AgentMission={id:command.missionId,agentId:agent.id,revision:1,objective:command.text,
    successCriteria:[{id:"request",description:"Satisfy the accepted request, with the work result as evidence when work is needed."}],status:"active",waitingReason:null,limits:command.limits,
    usage:{attempts:0,modelCalls:0,totalTokens:0,consecutiveNoProgress:0,clarificationRounds:0},createdAt:at,updatedAt:at};
  return workspaceTransition({...state,missions:[...state.missions,mission],messages:[...state.messages,{id:command.messageId,agentId:agent.id,missionId:mission.id,role:command.source?"abot":"user",purpose:command.intent==="message"?"conversation":"request",...(command.intent==="auto"?{inputIntent:"auto" as const}:{}),source:command.source,text:command.text,createdAt:at}]},agent.id,mission.id,"Accepted a bounded Agent request.");
}
export function reduceAgentWorkspace(state:AgentState,command:AgentWorkspaceCommand,at:string):AgentStateTransition {
  if(command.kind==="reconcile_cancelled_exchange") return reconcileCancelledExchange(state,command,at);
  if(command.kind==="reserve_conversation_reply"||command.kind==="publish_conversation_reply")return reduceConversationReply(state,command,at);
  if(command.kind==="reserve_peer_clarification"||command.kind==="settle_peer_clarification")return reduceAgentPeerClarification(state,command,at);
  if(command.kind==="open_agent_turn") return openTurn(state,command,at);
  if(command.kind==="prepare_agent_work"||command.kind==="claim_agent_work"||command.kind==="observe_agent_work") return reduceWorkspaceWork(state,command,at);
  if(command.kind==="record_agent_plan"||command.kind==="reject_agent_plan") return reduceWorkspacePlan(state,command,at);
  if(command.kind==="prepare_agent_exchange"||command.kind==="settle_agent_exchange") return reduceWorkspaceMailbox(state,command,at);
  const mission=requireWorkspaceMission(state,command.agentId,command.missionId);
  if(command.kind==="publish_recorded_work_result") {
    const bound = recordedWorkReplyCommand(state, mission, command.reason);
    if (!bound || bound.missionRevision !== command.missionRevision || bound.attemptId !== command.attemptId)
      return workspaceTransition(state, command.agentId, mission.id, "Stale recorded work delivery ignored.", true);
    const output = state.attempts.find(entry => entry.id === bound.attemptId)!.result!.output;
    const legacy = mission.status === "awaiting_user_decision";
    const next = replaceWorkspaceMission(state, {...mission, status:legacy ? "completed" : "exhausted", waitingReason:null, revision:mission.revision+1, updatedAt:at});
    if (!output?.trim()) return workspaceTransition(next, command.agentId, mission.id, "agent_work_result_empty:" + command.reason);
    let id = "work-result:" + bound.attemptId;
    while (state.messages.some(entry => entry.id === id)) id = "#" + id;
    const message = {id, agentId:mission.agentId, missionId:mission.id, role:"assistant" as const, purpose:"reply" as const, source:null, text:output, createdAt:at};
    return workspaceTransition({...next, messages:[...next.messages, message]}, command.agentId, mission.id, command.reason);
  }
  if(command.kind==="append_agent_message") {
    const existing=state.messages.find((entry)=>entry.id===command.messageId);
    if(existing) {
      if(existing.agentId!==command.agentId||existing.missionId!==mission.id||existing.role!==command.role||existing.text!==command.text) throw new AgentStateError("agents_message_identity_conflict");
      return workspaceTransition(state,command.agentId,mission.id,"Message already retained.",true);
    }
    return workspaceTransition({...state,messages:[...state.messages,{id:command.messageId,agentId:command.agentId,missionId:mission.id,role:command.role,...(command.purpose?{purpose:command.purpose}:{}),source:null,text:command.text,createdAt:at}]},command.agentId,mission.id,"Conversation message retained in the Agent context.");
  }
  if(command.kind==="ask_agent_user") {
    const trace=state.responsibility.find((entry)=>entry.id===command.traceId);
    if(!trace?.accepted||trace.missionId!==mission.id||trace.missionRevision!==mission.revision||trace.plan.action!=="ask_user"||mission.status!=="active") throw new AgentStateError("agents_clarification_plan_invalid");
    if(mission.usage.clarificationRounds>=mission.limits.maxClarificationRounds) throw new AgentStateError("agents_clarification_limit_reached");
    if(state.messages.some((entry)=>entry.id===command.messageId)) throw new AgentStateError("agents_message_identity_conflict");
    const next=replaceWorkspaceMission(state,{...mission,status:"awaiting_user_decision",waitingReason:"Clarification requested.",revision:mission.revision+1,updatedAt:at,usage:{...mission.usage,clarificationRounds:mission.usage.clarificationRounds+1}});
    return workspaceTransition({...next,messages:[...next.messages,{id:command.messageId,agentId:command.agentId,missionId:mission.id,role:"assistant",purpose:"question",traceId:command.traceId,source:null,text:command.text,createdAt:at}]},command.agentId,mission.id,"Clarification charged to the existing mission budget.");
  }
  if(command.kind==="resume_agent_turn") {
    if(state.mailbox.some((entry)=>entry.clarifications?.some((item)=>item.childMissionId===mission.id&&(item.status==="reserved"||item.status==="unknown"))))throw new AgentStateError("agents_peer_clarification_pending");
    if(mission.status!=="awaiting_user_decision") throw new AgentStateError("agents_mission_not_waiting");
    if (["agents_token_limit_reached","agents_model_call_limit_reached"].includes(mission.waitingReason ?? "") &&
      state.attempts.some(attempt => attempt.missionId === mission.id && attempt.status !== "settled" && !attempt.userResolved))
      throw new AgentStateError("agents_work_unresolved");
    const unresolved=state.attempts.some((entry)=>entry.missionId===mission.id&&(entry.status==="unknown"||entry.result?.usage===null));
    if(unresolved||state.invocations.some((entry)=>entry.missionId===mission.id&&entry.status!=="settled")||state.mailbox.some((entry)=>entry.missionId===mission.id&&(entry.status!=="answered"||entry.outcome===null))) throw new AgentStateError("agents_unknown_resolution_requires_new_mission");
    return workspaceTransition(replaceWorkspaceMission(state,{...mission,status:"active",waitingReason:null,revision:mission.revision+1,updatedAt:at}),command.agentId,mission.id,"Explicit user input resumes the same mission.");
  }
  if(command.kind==="mark_agent_waiting") {
    if(!isAgentMissionOpen(mission)) return workspaceTransition(state,command.agentId,mission.id,"Terminal mission retained.",true);
    if(mission.status==="awaiting_user_decision"&&mission.waitingReason===command.reason) return workspaceTransition(state,command.agentId,mission.id,"Waiting reason unchanged.",true);
    return workspaceTransition(replaceWorkspaceMission(state,{...mission,status:"awaiting_user_decision",waitingReason:command.reason,revision:mission.revision+1,updatedAt:at}),command.agentId,mission.id,command.reason);
  }
  if(command.kind==="finish_agent_turn") {
    if(!isAgentMissionOpen(mission)) return workspaceTransition(state,command.agentId,mission.id,"Terminal mission retained.",true);
    const trace=state.responsibility.find((entry)=>entry.id===command.traceId);
    if(command.status==="completed"&&(!trace?.accepted||trace.missionId!==mission.id||trace.missionRevision!==mission.revision||!["complete","answer_user"].includes(trace.plan.action))) throw new AgentStateError("agents_completion_plan_invalid");
    let next=replaceWorkspaceMission(state,{...mission,status:command.status,waitingReason:null,revision:mission.revision+1,updatedAt:at});
    if(command.messageId&&command.text) {
      if(state.messages.some((entry)=>entry.id===command.messageId)) throw new AgentStateError("agents_message_identity_conflict");
      next={...next,messages:[...next.messages,{id:command.messageId,agentId:command.agentId,missionId:mission.id,role:"assistant",purpose:"reply",source:null,text:command.text,createdAt:at}]};
    }
    return workspaceTransition(next,command.agentId,mission.id,command.reason);
  }
  throw new AgentStateError("agents_workspace_command_unknown");
}
