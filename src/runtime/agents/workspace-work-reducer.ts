import { agentEvidenceKeys } from "./workspace-evidence.js";
import { isDeepStrictEqual } from "node:util";
import type { AgentState } from "./agent-records.js";
import type { AgentWorkspaceCommand } from "./workspace-commands.js";
import type { AgentStateTransition } from "./state-transition.js";
import { AgentStateError } from "./state-error.js";
import { addWorkspaceUsage, replaceWorkspaceMission, requireAgentWorkAllowance, requireWorkspaceMission, workspaceTransition } from "./workspace-state.js";
import { agentWorkspaceHash } from "./workspace-validation.js";
import type { AgentWorkAttempt } from "./workspace-records.js";
type WorkCommand = Extract<AgentWorkspaceCommand,{kind:"prepare_agent_work"|"claim_agent_work"|"observe_agent_work"}>;
function withAttempt(state: AgentState, attempt: AgentWorkAttempt): AgentState {
  return {...state, attempts:state.attempts.map((entry)=>entry.id===attempt.id?attempt:entry)};
}
export function reduceWorkspaceWork(state: AgentState, command: WorkCommand, at:string):AgentStateTransition {
  if (command.kind === "prepare_agent_work") {
    const attempt=command.attempt;
    const existing=state.attempts.find((entry)=>entry.id===attempt.id||entry.request.requestId===attempt.request.requestId);
    if(existing) {
      if(existing.fingerprint!==attempt.fingerprint) throw new AgentStateError("agents_attempt_identity_conflict");
      return workspaceTransition(state,command.agentId,attempt.missionId,"Attempt already retained.",true);
    }
    if(attempt.agentId!==command.agentId) throw new AgentStateError("agents_attempt_owner_mismatch");
    const mission=requireWorkspaceMission(state,command.agentId,attempt.missionId,true);
    const agent=state.agents.find((entry)=>entry.id===command.agentId)!;
    if(agent.revision!==attempt.agentRevision||mission.revision!==attempt.missionRevision) throw new AgentStateError("agents_work_revision_changed");
    if(attempt.request.modelProfileId!==agent.definition.modelProfileId||attempt.request.toolPermissionMode!==agent.definition.toolPermissionMode) throw new AgentStateError("agents_work_configuration_mismatch");
    const trace=state.responsibility.find((entry)=>entry.id===command.traceId);
    if(!trace?.accepted||trace.missionId!==mission.id||trace.missionRevision!==mission.revision) throw new AgentStateError("agents_work_plan_unavailable");
    if(trace.plan.action!==(attempt.mode==="new"?"start_session":"continue_session")) throw new AgentStateError("agents_work_plan_mismatch");
    requireAgentWorkAllowance(state,mission);
    const session=state.sessions.find((entry)=>entry.sessionId===attempt.request.sessionId);
    if(attempt.mode==="new"&&session) throw new AgentStateError("agents_session_already_bound");
    if(attempt.mode==="continue"&&(!session||session.agentId!==agent.id||trace.plan.sessionId!==session.sessionId)) throw new AgentStateError("agents_session_owner_mismatch");
    if(attempt.status!=="prepared"||attempt.claimId!==null||attempt.result!==null||attempt.userResolved) throw new AgentStateError("agents_attempt_initial_state_invalid");
    const next=replaceWorkspaceMission(state,{...mission,updatedAt:at,usage:{...mission.usage,attempts:addWorkspaceUsage(mission.usage.attempts,1)}});
    return workspaceTransition({...next,attempts:[...state.attempts,attempt],sessions:session?state.sessions:[...state.sessions,{sessionId:attempt.request.sessionId,agentId:agent.id,purpose:attempt.request.assignment,createdAt:at}]},agent.id,mission.id,"Attempt and session association saved before dispatch.");
  }
  const attempt=state.attempts.find((entry)=>entry.id===command.attemptId&&entry.agentId===command.agentId);
  if(!attempt) throw new AgentStateError("agents_attempt_not_found");
  const mission=state.missions.find((entry)=>entry.id===attempt.missionId)!;
  if(command.kind==="claim_agent_work") {
    requireWorkspaceMission(state,command.agentId,attempt.missionId,true);
    if(state.agents.find((entry)=>entry.id===command.agentId)?.revision!==attempt.agentRevision) throw new AgentStateError("agents_agent_revision_conflict");
    if(mission.revision!==attempt.missionRevision) throw new AgentStateError("agents_mission_revision_conflict");
    if(attempt.status!=="prepared") throw new AgentStateError("agents_attempt_already_claimed");
    return workspaceTransition(withAttempt(state,{...attempt,status:"claimed",claimId:command.claimId,updatedAt:at}),command.agentId,mission.id,"Dispatch claimed durably before calling the ordinary runtime.");
  }
  const result=command.result;
  if(attempt.status==="settled") {
    if(!["completed","failed","cancelled"].includes(result.status)) return workspaceTransition(state,command.agentId,mission.id,"Stale nonterminal observation ignored after terminal settlement.",true);
    if (attempt.result?.usage && result.usage === null && attempt.result.receiptId && attempt.result.receiptId === result.receiptId &&
      isDeepStrictEqual({...attempt.result,usage:null},result))
      return workspaceTransition(state,command.agentId,mission.id,"Stale unmeasured observation ignored after exact receipt accounting.",true);
    if (attempt.result?.usage === null && result.usage && attempt.result.receiptId && attempt.result.receiptId === result.receiptId &&
      isDeepStrictEqual({...attempt.result,usage:result.usage},result)) {
      const measured = withAttempt(state,{...attempt,result,updatedAt:at});
      const accounted = replaceWorkspaceMission(measured,{...mission,updatedAt:at,usage:{...mission.usage,
        modelCalls:addWorkspaceUsage(mission.usage.modelCalls,result.usage.modelCalls),
        totalTokens:addWorkspaceUsage(mission.usage.totalTokens,result.usage.totalTokens)}});
      return workspaceTransition(accounted,command.agentId,mission.id,"Late measured usage retained once for the same terminal receipt.");
    }
    if(!isDeepStrictEqual(attempt.result,result)) throw new AgentStateError("agents_attempt_settlement_conflict");
    return workspaceTransition(state,command.agentId,mission.id,"Result already recorded.",true);
  }
  const terminal=["completed","failed","cancelled"].includes(result.status);
  const status=terminal?"settled":result.status==="awaiting_approval"?"awaiting_approval":result.status==="running"?"running":"unknown";
  if(isDeepStrictEqual(attempt.result,result)&&attempt.status===status) return workspaceTransition(state,command.agentId,mission.id,"Observation unchanged.",true);
  const outputHash=terminal&&result.output?agentWorkspaceHash(result.output):null;
  const priorKeys=new Set(state.attempts.filter((entry)=>entry.missionId===mission.id&&entry.id!==attempt.id).flatMap((entry)=>agentEvidenceKeys(entry.result)));
  const progress=agentEvidenceKeys(result).some((key)=>!priorKeys.has(key));
  let next=withAttempt(state,{...attempt,status,result,outputHash,updatedAt:at});
  if(terminal) next=replaceWorkspaceMission(next,{...mission,updatedAt:at,usage:{...mission.usage,
    modelCalls:addWorkspaceUsage(mission.usage.modelCalls,result.usage?.modelCalls??0),totalTokens:addWorkspaceUsage(mission.usage.totalTokens,result.usage?.totalTokens??0),
    consecutiveNoProgress:progress?0:addWorkspaceUsage(mission.usage.consecutiveNoProgress,1)}});
  if(status==="unknown"&&mission.status==="active"&&mission.revision===attempt.missionRevision) next=replaceWorkspaceMission(next,{...mission,status:"awaiting_user_decision",waitingReason:"The session outcome is unknown. Review it before choosing what happens next.",revision:mission.revision+1,updatedAt:at});
  return workspaceTransition(next,command.agentId,mission.id,terminal?"Exact ordinary session result retained; mission acceptance remains separate.":`Session status: ${status}.`);
}
