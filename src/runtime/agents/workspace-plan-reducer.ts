import { currentReturnedWorkAttempt } from "./work-result-context.js";
import { agentCompletionEvidence } from "./workspace-evidence.js";
import type { AgentState } from "./agent-records.js";
import type { AgentWorkspaceCommand } from "./workspace-commands.js";
import { AgentStateError } from "./state-error.js";
import { hasUnresolvedAgentWork, requireWorkspaceMission, workspaceTransition } from "./workspace-state.js";
import type { AgentStateTransition } from "./state-transition.js";
import type { AgentActionPlan, AgentResponsibilityTrace } from "./workspace-records.js";

function planRejection(state:AgentState,agentId:string,missionId:string,invocationId:string,plan:AgentActionPlan):string|null {
  const mission=state.missions.find((entry)=>entry.id===missionId)!;
  const agent=state.agents.find((entry)=>entry.id===agentId)!;
  const invocation=state.invocations.find((entry)=>entry.id===invocationId);
  if(!invocation||invocation.agentId!==agentId||invocation.missionId!==missionId) return "invocation_missing";
  if(invocation.status!=="settled") return "invocation_usage_unknown";
  if(invocation.agentRevision!==agent.revision||invocation.missionRevision!==mission.revision) return "stale_source";
  const stage=agent.definition.executionPolicy==="supervisor-worker-v1"?"selection":"assessment_and_selection";
  if(invocation.stage!==stage) return "invalid_selection_stage";
  if(state.messages.find((entry)=>entry.missionId===missionId)?.purpose==="conversation"&&!["answer_user","ask_user","wait","exhausted"].includes(plan.action)) return "conversation_cannot_dispatch";
  if(mission.status!=="active") return "mission_inactive";
  if(hasUnresolvedAgentWork(state,missionId)) return "work_unresolved";
  if(plan.sessionId&&!state.sessions.some((entry)=>entry.sessionId===plan.sessionId&&entry.agentId===agentId)) return "foreign_session";
  if(plan.evidenceIds.some((id)=>!state.attempts.some((entry)=>entry.id===id&&entry.agentId===agentId&&entry.status==="settled")&&!state.mailbox.some((entry)=>entry.id===id&&entry.agentId===agentId&&entry.status==="answered"))) return "evidence_unavailable";
  const receipt = currentReturnedWorkAttempt(state, mission);
  if (receipt) {
    if (plan.action !== "answer_user" && plan.action !== "continue_session") return "invalid_work_result_action";
    if (plan.evidenceIds.length !== 1 || plan.evidenceIds[0] !== receipt.id || plan.metCriteriaIds.length) return "work_result_binding_mismatch";
    if (plan.action === "continue_session" && plan.sessionId !== receipt.request.sessionId) return "work_result_binding_mismatch";
    return null;
  }
  if(plan.metCriteriaIds.some((id)=>!mission.successCriteria.some((criterion)=>criterion.id===id))) return "criterion_unavailable";
  if(plan.action==="complete"&&mission.successCriteria.some((criterion)=>!plan.metCriteriaIds.includes(criterion.id))) return "acceptance_incomplete";
  if(plan.action==="complete"&&plan.evidenceIds.some((id)=>!agentCompletionEvidence(state,agentId,missionId,id))) return "acceptance_evidence_invalid";
  if(plan.action==="complete"&&plan.evidenceIds.length===0) return "acceptance_evidence_missing";
  if(plan.action==="answer_user"&&(state.attempts.some((entry)=>entry.missionId===missionId)||state.mailbox.some((entry)=>entry.missionId===missionId))) return "work_requires_acceptance";
  if(plan.action==="delegate_agent"&&agentId!=="abot") return "delegation_not_allowed";
  if(plan.action==="delegate_agent"&&!state.agents.some((entry)=>entry.id===plan.recipientAgentId&&entry.id!==agentId&&entry.status==="active")) return "recipient_unavailable";
  return null;
}
export function reduceWorkspacePlan(state:AgentState,command:Extract<AgentWorkspaceCommand,{kind:"record_agent_plan"|"reject_agent_plan"}>,at:string):AgentStateTransition {
  const mission = requireWorkspaceMission(state,command.agentId,command.missionId);
  const invocation=state.invocations.find((entry)=>entry.id===command.invocationId);
  if(!invocation) throw new AgentStateError("agents_invocation_not_found");
  const existing=state.responsibility.find((entry)=>entry.id===command.traceId||entry.invocationId===command.invocationId);
  if(existing) throw new AgentStateError("agents_plan_already_recorded");
  const plan:AgentActionPlan=command.kind==="record_agent_plan"?command.plan:{action:"wait",reason:"The model response did not match the closed decision contract.",sessionId:null,recipientAgentId:null,evidenceIds:[],metCriteriaIds:[]};
  let rejected;
  if (command.kind === "reject_agent_plan") {
    rejected = currentReturnedWorkAttempt(state, mission) ? "malformed_work_result_decision" : "malformed_proposal";
  } else {
    rejected = planRejection(state,command.agentId,command.missionId,command.invocationId,plan);
  }
  const trace:AgentResponsibilityTrace={id:command.traceId,agentId:command.agentId,missionId:command.missionId,
    agentRevision:invocation.agentRevision,missionRevision:invocation.missionRevision,invocationId:invocation.id,
    plan,accepted:rejected===null,code:rejected??"accepted",createdAt:at};
  return workspaceTransition({...state,responsibility:[...state.responsibility,trace]},command.agentId,command.missionId,rejected?`Decision rejected: ${rejected}.`:plan.reason);
}
