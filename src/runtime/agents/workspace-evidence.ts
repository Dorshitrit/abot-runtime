import { agentNeedsNewBudget } from "./conversation-availability.js";
import type { AgentWorkspaceCommand } from "./workspace-commands.js";
import type { AgentMission, AgentState } from "./agent-records.js";
import type { AgentWorkResult } from "./application-contracts.js";
/** Reworded output is not progress. Only new normalized source identifiers count here. */
export function agentEvidenceKeys(result:AgentWorkResult|null):readonly string[] {
  if(result?.status!=="completed"||!result.output) return [];
  const keys=new Set<string>();
  for(const match of result.output.matchAll(/https?:\/\/[^\s<>\[\]()"']+/g)) {
    try {const url=new URL(match[0].replace(/[.,;:!?]+$/,""));url.hash="";url.searchParams.sort();keys.add(url.href);} catch { /* Not an evidence identifier. */ }
  }
  return [...keys].sort();
}
export function agentCompletionEvidence(state:AgentState,agentId:string,missionId:string,id:string):boolean {
  const exchange=state.mailbox.find((entry)=>entry.id===id&&entry.agentId===agentId&&entry.missionId===missionId&&entry.status==="answered"&&entry.outcome==="completed"&&entry.usage!==null&&entry.output!==null);
  if(exchange) return true;
  const attempt=state.attempts.find((entry)=>entry.id===id&&entry.agentId===agentId&&entry.status==="settled"&&entry.result?.status==="completed"&&entry.result.usage!==null);
  if(!attempt) return false;
  if(attempt.missionId===missionId) return true;
  return state.responsibility.some((entry)=>entry.agentId===agentId&&entry.missionId===missionId&&entry.accepted&&entry.plan.action==="read_evidence"&&entry.plan.sessionId===attempt.request.sessionId);
}

const rejectedRecordedReply = "agents_plan_rejected_work_requires_acceptance";
const recordedReplyFailures = new Set([
  "agents_token_limit_reached", "agents_model_call_limit_reached", "agents_attempt_limit_reached",
  "agents_no_progress_limit_reached", "agents_plan_invalid", "agents_management_output_empty",
  "agents_work_reply_too_long", "agents_context_capacity_exceeded",
]);

/** Bind terminal delivery to a measured result. The command carries no caller-supplied response text. */
export function recordedWorkReplyCommand(state: AgentState, mission: AgentMission, reason: string):
  Extract<AgentWorkspaceCommand, {kind:"publish_recorded_work_result"}> | undefined {
  const legacy = mission.status === "awaiting_user_decision";
  if (legacy && (reason !== rejectedRecordedReply || mission.waitingReason !== reason)) return;
  if (!legacy && (mission.status !== "active" || !recordedReplyFailures.has(reason))) return;
  if (agentNeedsNewBudget(state, mission.id)) return;
  const agent = state.agents.find(entry => entry.id === mission.agentId && entry.status === "active");
  const attempts = state.attempts.filter(entry => entry.agentId === mission.agentId && entry.missionId === mission.id);
  if (attempts.some(entry => entry.status !== "settled" || entry.userResolved)) return;
  const attempt = attempts.at(-1);
  if (!agent || !attempt?.result?.usage || attempt.agentRevision !== agent.revision) return;
  if (attempt.missionRevision !== mission.revision - (legacy ? 1 : 0)) return;
  if (!state.sessions.some(entry => entry.agentId === agent.id && entry.sessionId === attempt.request.sessionId)) return;
  const traces = state.responsibility.filter(entry => entry.agentId === agent.id && entry.missionId === mission.id);
  if (legacy) {
    const trace = traces.at(-1);
    if (!trace || trace.accepted || trace.code !== "work_requires_acceptance" || trace.plan.action !== "answer_user") return;
    if (trace.agentRevision !== agent.revision || trace.missionRevision !== attempt.missionRevision) return;
    if (trace.plan.evidenceIds.length !== 1 || trace.plan.evidenceIds[0] !== attempt.id) return;
    if (attempt.result.status !== "completed" || !attempt.result.output?.trim()) return;
  }
  // A later peer result belongs to a different decision, even when both share this mission.
  if (traces.some(entry => entry.accepted && entry.plan.action === "delegate_agent" && entry.createdAt >= attempt.createdAt)) return;
  return {kind:"publish_recorded_work_result", agentId:agent.id, missionId:mission.id, missionRevision:mission.revision, attemptId:attempt.id, reason};
}
