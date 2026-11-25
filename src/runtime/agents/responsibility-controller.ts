import { initialAgentMessage } from "./conversation-intent.js";
import { randomUUID } from "node:crypto";
import type { AgentApplicationDependencies } from "./application-contracts.js";
import { createAgentManagementModel } from "./management-model.js";
import { agentAuthorInstructions, agentDecisionInstructions, type AgentDecisionSubject } from "./management-prompts.js";
import { currentReturnedWorkAttempt } from "./work-result-context.js";
import type { AgentState } from "./agent-records.js";
import { AGENT_PLAN_FORMAT, AGENT_WORK_RESULT_FORMAT, readAgentPlanOutput } from "./plan-output-contract.js";
import { AgentStateError } from "./state-error.js";
import { AGENT_WORKSPACE_TEXT_LIMIT } from "./workspace-validation.js";
import { dispatchAgentPeer, dispatchAgentWork } from "./application-dispatch.js";

function decisionSubject(state: AgentState, missionId: string, returnedExchangeId?: string, returnedAttemptId?: string): AgentDecisionSubject {
  if (returnedExchangeId) return "returned_delegation";
  if (returnedAttemptId) return "returned_work";
  if (state.attempts.some(record => record.missionId === missionId) || state.mailbox.some(record => record.missionId === missionId)) return "ongoing_work";
  return "request";
}

export function createAgentResponsibilityController(deps:AgentApplicationDependencies) {
  const invoke=createAgentManagementModel(deps);
  return async (agentId:string,missionId:string,signal:AbortSignal):Promise<void> => {
    let readSessionId:string|undefined;
    let returnedExchangeId: string | undefined;
    for(;;) {
      signal.throwIfAborted();
      const state=await deps.store.read(),mission=state.missions.find((entry)=>entry.id===missionId),agent=state.agents.find((entry)=>entry.id===agentId);
      if(!mission||!agent||mission.status!=="active") return;
      const origin=initialAgentMessage(state,missionId);
      if(origin?.purpose==="conversation")return;
      const automatic = origin?.inputIntent === "auto";
      if(state.attempts.some((entry)=>entry.missionId===missionId&&entry.status!=="settled")) return;
      if(state.attempts.some((entry)=>entry.missionId===missionId&&entry.result?.usage===null)) throw new AgentStateError("agents_work_usage_unknown");
      const common={agentId,missionId,signal,returnedExchangeId,...(readSessionId?{readSessionId}:{})};
      returnedExchangeId = undefined;
      const superPolicy=agent.definition.executionPolicy==="supervisor-worker-v1";
      const receipt = common.returnedExchangeId ? undefined : currentReturnedWorkAttempt(state, mission);
      const subject = decisionSubject(state, missionId, common.returnedExchangeId, receipt?.id);
      const decision = {...common, returnedAttemptId:receipt?.id};
      const assessment = superPolicy ? (await invoke({...decision, stage:"assessment",
        instructions:agentDecisionInstructions("assessment", automatic, subject)})).text : undefined;
      const stage = superPolicy ? "selection" : "assessment_and_selection";
      const choice = await invoke({...decision, stage, instructions:agentDecisionInstructions(stage, automatic, subject),
        format:receipt ? AGENT_WORK_RESULT_FORMAT : AGENT_PLAN_FORMAT,...(assessment?{assessment}:{})});
      const traceId=randomUUID();
      let plan;
      try {plan=readAgentPlanOutput(choice.text, receipt);} catch(error) {await deps.store.commitApplication({kind:"reject_agent_plan",agentId,missionId,traceId,invocationId:choice.invocationId});throw new AgentStateError("agents_plan_invalid",{cause:error});}
      const planned=await deps.store.commitApplication({kind:"record_agent_plan",agentId,missionId,traceId,invocationId:choice.invocationId,plan});
      const trace=planned.responsibility.find((entry)=>entry.id===traceId)!;
      if(!trace.accepted) throw new AgentStateError(`agents_plan_rejected_${trace.code}`);
      if(plan.action==="read_evidence") {readSessionId=plan.sessionId!;continue;}
      const workAssignment = plan.action === "start_session" || plan.action === "continue_session";
      const instructions = agentAuthorInstructions(plan.action, subject);
      const authored=await invoke({...decision,stage:"authoring",instructions,plan});
      signal.throwIfAborted();
      if (receipt && authored.text.length > AGENT_WORKSPACE_TEXT_LIMIT) throw new AgentStateError("agents_work_reply_too_long");
      // The reducer rechecks the trace's exact mission revision before any dispatch.
      if(workAssignment) {
        const result=await dispatchAgentWork(deps,trace,authored.text,signal);
        if(result.status==="running"||result.status==="awaiting_approval"||result.status==="unknown") return;
        continue;
      }
      if (plan.action === "delegate_agent") {
        returnedExchangeId = await dispatchAgentPeer(deps, trace, authored.text, signal);
        continue;
      }
      if(plan.action==="ask_user") {
        await deps.store.commitApplication({kind:"ask_agent_user",agentId,missionId,traceId,messageId:randomUUID(),text:authored.text});return;
      }
      if(plan.action==="wait") {
        await deps.store.commitApplication({kind:"append_agent_message",agentId,missionId,messageId:randomUUID(),role:"assistant",text:authored.text});
        await deps.store.commitApplication({kind:"mark_agent_waiting",agentId,missionId,reason:plan.reason});
      } else await deps.store.commitApplication({kind:"finish_agent_turn",agentId,missionId,status:plan.action==="exhausted"?"exhausted":"completed",reason:plan.reason,traceId,messageId:randomUUID(),text:authored.text});
      return;
    }
  };
}
