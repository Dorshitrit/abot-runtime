import { wasAgentDeleted } from "./deletion-state.js";
import type { AgentState } from "./agent-records.js";
import type { AgentWorkspaceCommand } from "./workspace-commands.js";
import type { AgentStateTransition } from "./state-transition.js";
import { AgentStateError } from "./state-error.js";
import { addWorkspaceUsage, replaceWorkspaceMission, requireAgentWorkAllowance, requireWorkspaceMission, workspaceTransition } from "./workspace-state.js";
import { isDeepStrictEqual } from "node:util";
type MailboxCommand=Extract<AgentWorkspaceCommand,{kind:"prepare_agent_exchange"|"settle_agent_exchange"}>;
export function reduceWorkspaceMailbox(state:AgentState,command:MailboxCommand,at:string):AgentStateTransition {
  if(command.kind==="prepare_agent_exchange") {
    const record=command.record;
    if (state.deletingAgentIds.includes(record.recipientAgentId)) throw new AgentStateError("agents_deletion_pending");
    if (wasAgentDeleted(state, record.recipientAgentId)) throw new AgentStateError("agents_agent_not_found");
    if(command.agentId!=="abot"||record.agentId!==command.agentId) throw new AgentStateError("agents_delegation_forbidden");
    const mission=requireWorkspaceMission(state,command.agentId,record.missionId,true);
    requireAgentWorkAllowance(state,mission);
    if(mission.revision!==record.missionRevision) throw new AgentStateError("agents_mission_revision_conflict");
    if(mission.usage.clarificationRounds>=mission.limits.maxClarificationRounds) throw new AgentStateError("agents_clarification_limit_reached");
    const trace=state.responsibility.find((entry)=>entry.id===record.traceId);
    if(!trace?.accepted||trace.missionId!==mission.id||trace.plan.action!=="delegate_agent"||trace.plan.recipientAgentId!==record.recipientAgentId) throw new AgentStateError("agents_exchange_plan_invalid");
    if(state.mailbox.some((entry)=>entry.id===record.id||entry.traceId===record.traceId)) throw new AgentStateError("agents_exchange_already_claimed");
    if(record.status!=="pending") throw new AgentStateError("agents_exchange_initial_status");
    if(record.limits.maxAttempts>mission.limits.maxAttempts-mission.usage.attempts||record.limits.maxModelCalls>mission.limits.maxModelCalls-mission.usage.modelCalls||record.limits.maxTotalTokens>mission.limits.maxTotalTokens-mission.usage.totalTokens||record.limits.maxClarificationRounds>mission.limits.maxClarificationRounds-mission.usage.clarificationRounds-1) throw new AgentStateError("agents_exchange_budget_escalation");
    const next=replaceWorkspaceMission(state,{...mission,updatedAt:at,usage:{...mission.usage,clarificationRounds:mission.usage.clarificationRounds+1}});
    return workspaceTransition({...next,mailbox:[...state.mailbox,record]},command.agentId,mission.id,"Delegation and its reserved allowance saved before contacting the Agent.");
  }
  const record=state.mailbox.find((entry)=>entry.id===command.exchangeId&&entry.agentId===command.agentId);
  if(!record) throw new AgentStateError("agents_exchange_not_found");
  if(record.status!=="pending") {
    if(!isDeepStrictEqual(record.usage,command.usage)||record.output!==command.output||record.outcome!==command.outcome) throw new AgentStateError("agents_exchange_result_conflict");
    return workspaceTransition(state,command.agentId,record.missionId,"Peer result already retained.",true);
  }
  const mission=state.missions.find((entry)=>entry.id===record.missionId)!;
  const updated={...record,status:command.usage===null?"unknown" as const:"answered" as const,output:command.output,usage:command.usage,outcome:command.outcome,updatedAt:at};
  let next:AgentState={...state,mailbox:state.mailbox.map((entry)=>entry.id===record.id?updated:entry)};
  if(command.usage) next=replaceWorkspaceMission(next,{...mission,updatedAt:at,usage:{...mission.usage,
    modelCalls:addWorkspaceUsage(mission.usage.modelCalls,command.usage.modelCalls),totalTokens:addWorkspaceUsage(mission.usage.totalTokens,command.usage.totalTokens),
    attempts:addWorkspaceUsage(mission.usage.attempts,command.usage.attempts),clarificationRounds:addWorkspaceUsage(mission.usage.clarificationRounds,command.usage.clarificationRounds)}});
  if(command.usage===null&&mission.status==="active") next=replaceWorkspaceMission(next,{...mission,status:"awaiting_user_decision",waitingReason:"A delegated result or its usage is unknown. A user decision is required.",revision:mission.revision+1,updatedAt:at});
  return workspaceTransition(next,command.agentId,mission.id,"Peer reply retained in the original mission budget.");
}
