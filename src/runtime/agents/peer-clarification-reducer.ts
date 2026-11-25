import type { AgentMission, AgentState } from "./agent-records.js";
import type { AgentWorkspaceCommand } from "./workspace-commands.js";
import type { AgentStateTransition } from "./state-transition.js";
import type { AgentMailboxRecord } from "./workspace-records.js";
import { AgentStateError } from "./state-error.js";
import { reduceAgentInvocation } from "./invocation-reducer.js";
import { replaceWorkspaceMission, requireWorkspaceMission, workspaceTransition } from "./workspace-state.js";
type Command=Extract<AgentWorkspaceCommand,{kind:"reserve_peer_clarification"|"settle_peer_clarification"}>;
const replaceExchange=(state:AgentState,exchange:AgentMailboxRecord):AgentState=>({...state,mailbox:state.mailbox.map((entry)=>entry.id===exchange.id?exchange:entry)});
function frozen(mission:AgentMission,reason:string,at:string):AgentMission {
  if(mission.status==="cancelled"||mission.status==="completed"||mission.status==="exhausted")return mission;
  return {...mission,status:"awaiting_user_decision",waitingReason:reason,revision:mission.revision+1,updatedAt:at};
}
/** Transfers an exclusive slice of an idle child's allocation; the parent ledger charges the actual reply once. */
export function reduceAgentPeerClarification(state:AgentState,command:Command,at:string):AgentStateTransition {
  const exchange=state.mailbox.find((entry)=>entry.id===command.exchangeId&&entry.agentId===command.agentId&&entry.missionId===command.missionId);
  if(!exchange||command.agentId!=="abot")throw new AgentStateError("agents_peer_exchange_missing");
  if(command.kind==="reserve_peer_clarification") {
    const parent=requireWorkspaceMission(state,command.agentId,command.missionId,true);
    const child=requireWorkspaceMission(state,exchange.recipientAgentId,command.childMissionId);
    if(exchange.status!=="pending"||child.status!=="awaiting_user_decision")throw new AgentStateError("agents_peer_not_waiting");
    if(state.messages.find((entry)=>entry.missionId===child.id)?.source?.correlationId!==exchange.id)throw new AgentStateError("agents_peer_mission_mismatch");
    const question=state.messages.find((entry)=>entry.id===command.questionMessageId&&entry.agentId===child.agentId&&entry.missionId===child.id&&entry.purpose==="question");
    const latest=[...state.messages].reverse().find((entry)=>entry.missionId===child.id&&entry.purpose==="question");
    const trace=state.responsibility.find((entry)=>entry.id===question?.traceId);
    if(!question||latest?.id!==question.id||!trace?.accepted||trace.plan.action!=="ask_user")throw new AgentStateError("agents_peer_question_invalid");
    const records=exchange.clarifications??[];
    if(records.some((entry)=>entry.questionMessageId===question.id||entry.id===command.clarificationId))throw new AgentStateError("agents_peer_question_already_claimed");
    if(records.length>=exchange.limits.maxClarificationRounds)throw new AgentStateError("agents_clarification_limit_reached");
    if(state.invocations.some((entry)=>entry.missionId===child.id&&entry.status!=="settled")||state.attempts.some((entry)=>entry.missionId===child.id&&(entry.status!=="settled"||entry.result?.usage===null)))throw new AgentStateError("agents_peer_child_unsettled");
    if(child.limits.maxModelCalls-child.usage.modelCalls<1||child.limits.maxTotalTokens-child.usage.totalTokens<command.reservedTokens)throw new AgentStateError("agents_peer_reply_budget_exhausted");
    const record={id:command.clarificationId,childAgentId:child.agentId,childMissionId:child.id,questionMessageId:question.id,question:question.text,invocationId:command.invocationId,reservedTokens:command.reservedTokens,status:"reserved" as const,answer:null,usageTokens:null,createdAt:at,updatedAt:at};
    let next=replaceWorkspaceMission(state,{...child,revision:child.revision+1,updatedAt:at,limits:{...child.limits,maxModelCalls:child.limits.maxModelCalls-1,maxTotalTokens:child.limits.maxTotalTokens-command.reservedTokens}});
    next=replaceExchange(next,{...exchange,clarifications:[...records,record],limits:{...exchange.limits,maxModelCalls:exchange.limits.maxModelCalls-1,maxTotalTokens:exchange.limits.maxTotalTokens-command.reservedTokens},updatedAt:at});
    next=reduceAgentInvocation(next,{kind:"reserve_invocation",agentId:command.agentId,missionId:parent.id,invocationId:command.invocationId,agentRevision:command.agentRevision,missionRevision:command.missionRevision,configuration:command.configuration,stage:"authoring",reservedTokens:command.reservedTokens},at).state;
    return workspaceTransition(next,command.agentId,parent.id,"A finite child allowance is exclusively lent to the coordinator reply.");
  }
  const record=exchange.clarifications?.find((entry)=>entry.id===command.clarificationId);
  if(!record)throw new AgentStateError("agents_peer_clarification_missing");
  if(record.status!=="reserved")return workspaceTransition(state,command.agentId,command.missionId,"Peer clarification was already settled.",true);
  const parent=state.missions.find((entry)=>entry.id===command.missionId)!,child=state.missions.find((entry)=>entry.id===record.childMissionId)!;
  const invocation=state.invocations.find((entry)=>entry.id===record.invocationId);
  const tokens=invocation?.status==="settled"?invocation.usage!.totalTokens:null;
  const refund=tokens===null?0:record.reservedTokens-tokens;
  const overrun=refund<0;
  const outcome=tokens===null||overrun?"unknown":command.outcome;
  const status=outcome==="answer"?"answered":outcome==="needs_user"?"awaiting_user_decision":"unknown";
  if(outcome==="answer"&&!command.text?.trim())throw new AgentStateError("agents_peer_answer_missing");
  let next=replaceExchange(state,{...exchange,limits:{...exchange.limits,maxTotalTokens:Math.max(0,exchange.limits.maxTotalTokens+refund)},updatedAt:at,
    clarifications:exchange.clarifications!.map((entry)=>entry.id===record.id?{...entry,status,answer:command.text,usageTokens:tokens,updatedAt:at}:entry)});
  let updatedChild={...child,updatedAt:at,limits:{...child.limits,maxTotalTokens:Math.max(child.usage.totalTokens,child.limits.maxTotalTokens+refund)}};
  if(outcome==="unknown") {
    const reason="The coordinator clarification or its usage is unknown. A user decision is required.";
    next=replaceWorkspaceMission(next,frozen(parent,reason,at));updatedChild=frozen(updatedChild,reason,at);
  } else if(outcome==="answer"&&child.status==="awaiting_user_decision"&&parent.status==="active") {
    updatedChild={...updatedChild,status:"active",waitingReason:null,revision:child.revision+1};
    next={...next,messages:[...next.messages,{id:`peer-reply:${record.id}`,agentId:child.agentId,missionId:child.id,role:"abot",purpose:"clarification",source:{agentId:parent.agentId,missionId:parent.id,correlationId:exchange.id},text:command.text!,createdAt:at}]};
  }
  next=replaceWorkspaceMission(next,updatedChild);
  return workspaceTransition(next,command.agentId,parent.id,"Coordinator reply cost is retained once; unused loaned tokens return to the child.");
}
