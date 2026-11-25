import { boundedAgentWorkAssignment } from "./work-budget-context.js";
import { randomUUID } from "node:crypto";
import type { AgentApplicationDependencies, AgentWorkRequest, AgentWorkResult } from "./application-contracts.js";
import type { AgentResponsibilityTrace, AgentWorkAttempt } from "./workspace-records.js";
import { agentWorkspaceHash } from "./workspace-validation.js";
import { AgentStateError } from "./state-error.js";
export const UNKNOWN_AGENT_WORK:AgentWorkResult={status:"unknown",output:null,error:"The ordinary request outcome could not be established.",usage:null,receiptId:null};
/** Source-side intent and a durable claim precede every external call. There is no retry here. */
export async function dispatchAgentWork(deps:AgentApplicationDependencies,trace:AgentResponsibilityTrace,assignment:string,signal:AbortSignal):Promise<AgentWorkResult> {
  signal.throwIfAborted();
  const state=await deps.store.read(),agent=state.agents.find((entry)=>entry.id===trace.agentId)!,mission=state.missions.find((entry)=>entry.id===trace.missionId)!;
  const id=randomUUID(),at=new Date().toISOString();
  const request:AgentWorkRequest={agentId:agent.id,missionId:mission.id,attemptId:id,requestId:randomUUID(),sessionId:trace.plan.sessionId??randomUUID(),assignment:boundedAgentWorkAssignment(assignment,state,mission,agent),modelProfileId:agent.definition.modelProfileId,toolPermissionMode:agent.definition.toolPermissionMode};
  const attempt:AgentWorkAttempt={id,agentId:agent.id,missionId:mission.id,agentRevision:trace.agentRevision,missionRevision:trace.missionRevision,request,
    mode:trace.plan.action==="start_session"?"new":"continue",fingerprint:agentWorkspaceHash(request),status:"prepared",claimId:null,result:null,outputHash:null,userResolved:false,createdAt:at,updatedAt:at};
  await deps.store.commitApplication({kind:"prepare_agent_work",agentId:agent.id,attempt,traceId:trace.id});
  signal.throwIfAborted();
  await deps.store.commitApplication({kind:"claim_agent_work",agentId:agent.id,attemptId:id,claimId:randomUUID()});
  let result:AgentWorkResult,dispatched=false;
  try {
    if(attempt.mode==="new") await deps.work.createSession(request);
    signal.throwIfAborted();
    dispatched=true;
    result=await deps.work.run(request,signal);
  } catch(error) {
    if(dispatched) result=await deps.work.inspect(request).catch(()=>UNKNOWN_AGENT_WORK);
    else result={status:signal.aborted?"cancelled":"failed",output:null,error:error instanceof Error?error.message:"Session creation failed.",usage:{modelCalls:0,totalTokens:0},receiptId:null};
  }
  await deps.store.commitApplication({kind:"observe_agent_work",agentId:agent.id,attemptId:id,result});
  return result;
}
export async function dispatchAgentPeer(deps:AgentApplicationDependencies,trace:AgentResponsibilityTrace,assignment:string,signal:AbortSignal):Promise<string> {
  if(!deps.coordinate) throw new AgentStateError("agents_coordination_unavailable");
  signal.throwIfAborted();
  const state=await deps.store.read(),agent=state.agents.find((entry)=>entry.id===trace.agentId)!,mission=state.missions.find((entry)=>entry.id===trace.missionId)!;
  const limits={maxAttempts:mission.limits.maxAttempts-mission.usage.attempts,maxModelCalls:mission.limits.maxModelCalls-mission.usage.modelCalls,
    maxTotalTokens:mission.limits.maxTotalTokens-mission.usage.totalTokens,maxConsecutiveNoProgress:mission.limits.maxConsecutiveNoProgress,
    maxClarificationRounds:Math.max(0,mission.limits.maxClarificationRounds-mission.usage.clarificationRounds-1)};
  const id=randomUUID(),at=new Date().toISOString();
  await deps.store.commitApplication({kind:"prepare_agent_exchange",agentId:agent.id,record:{id,agentId:agent.id,missionId:mission.id,missionRevision:trace.missionRevision,traceId:trace.id,recipientAgentId:trace.plan.recipientAgentId!,assignment,limits,status:"pending",outcome:null,output:null,usage:null,createdAt:at,updatedAt:at}});
  try {
    const result=await deps.coordinate({correlationId:id,senderAgentId:agent.id,missionId:mission.id,recipientAgentId:trace.plan.recipientAgentId!,assignment,limits,toolPermissionMode:agent.definition.toolPermissionMode,signal});
    await deps.store.commitApplication({kind:"settle_agent_exchange",agentId:agent.id,exchangeId:id,output:result.text,usage:result.usage,outcome:result.outcome});
    return id;
  } catch(error) {
    await deps.store.commitApplication({kind:"settle_agent_exchange",agentId:agent.id,exchangeId:id,output:null,usage:null,outcome:null});
    throw error;
  }
}
