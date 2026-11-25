import type { AgentState } from "./agent-records.js";
import { conversationInvocationId, initialAgentMessage } from "./conversation-intent.js";
import { rejectAgentRecord } from "./record-validation.js";
import { agentWorkspaceHash } from "./workspace-validation.js";
/** Cross-record checks apply equally to fresh commits, reload and restored state. */
export function validateAgentWorkspaceIntegrity(state:AgentState):void {
  const answeredQuestionIds = new Set<string>();
  const withdrawnMissions = new Set<string>();
  for(const message of state.messages) {
    if (message.correctableAttemptId) {
      const origin = initialAgentMessage(state, message.missionId);
      const attempt = state.attempts.find(entry => entry.id === message.correctableAttemptId);
      if (origin?.role !== "user" || origin.source || origin.purpose !== "request" ||
          attempt?.agentId !== message.agentId || attempt.missionId !== message.missionId)
        rejectAgentRecord("workspace.correction_attempt_owner");
    }
    if (message.withdrawnAttemptId) {
      const source = state.messages.find(entry => message.id === "reply:" + entry.id && entry.missionId === message.missionId);
      const attempt = state.attempts.find(entry => entry.id === message.withdrawnAttemptId);
      const mission = state.missions.find(entry => entry.id === message.missionId);
      if (!source || !attempt || source.correctableAttemptId !== attempt.id || mission?.status !== "cancelled" ||
          mission.revision !== attempt.missionRevision + 1 || withdrawnMissions.has(mission.id))
        rejectAgentRecord("workspace.withdrawal_binding");
      const id = conversationInvocationId(mission.id, source.id, attempt.agentRevision, attempt.missionRevision);
      if (!state.invocations.some(entry => entry.id === id && entry.missionId === mission.id && entry.agentId === message.agentId &&
          entry.agentRevision === attempt.agentRevision && entry.missionRevision === attempt.missionRevision && entry.stage === "authoring" && entry.status === "settled"))
        rejectAgentRecord("workspace.withdrawal_receipt");
      withdrawnMissions.add(mission.id);
    }
    if (message.inReplyTo) {
      const question=state.messages.find((entry)=>entry.id===message.inReplyTo&&entry.agentId===message.agentId&&entry.missionId===message.missionId&&entry.purpose==="question");
      if(!question||answeredQuestionIds.has(question.id))rejectAgentRecord("workspace.user_question_binding");
      answeredQuestionIds.add(question.id);
    }
    if(!message.source)continue;
    const exchange=state.mailbox.find((entry)=>entry.id===message.source!.correlationId);
    if(!exchange||exchange.agentId!==message.source.agentId||exchange.missionId!==message.source.missionId||exchange.recipientAgentId!==message.agentId||(exchange.assignment!==message.text&&!(message.purpose==="clarification"&&exchange.clarifications?.some((entry)=>entry.childMissionId===message.missionId&&entry.status==="answered"&&entry.answer===message.text))))rejectAgentRecord("workspace.message_source");
  }
  for(const message of state.messages.filter((entry)=>entry.purpose==="question")) {
    const trace=state.responsibility.find((entry)=>entry.id===message.traceId);
    if(!trace?.accepted||trace.agentId!==message.agentId||trace.missionId!==message.missionId||trace.plan.action!=="ask_user")rejectAgentRecord("workspace.question_trace");
  }
  for(const attempt of state.attempts) {
    const agent=state.agents.find((entry)=>entry.id===attempt.agentId)!;
    if(attempt.agentRevision===agent.revision&&(attempt.request.modelProfileId!==agent.definition.modelProfileId||attempt.request.toolPermissionMode!==agent.definition.toolPermissionMode))rejectAgentRecord("workspace.attempt_configuration");
    if(attempt.status==="prepared"&&attempt.result!==null)rejectAgentRecord("workspace.unclaimed_result");
    if(attempt.status==="claimed"&&attempt.result!==null)rejectAgentRecord("workspace.unobserved_result");
    if(attempt.status==="running"&&attempt.result?.status!=="running")rejectAgentRecord("workspace.running_result");
    if(attempt.status==="awaiting_approval"&&attempt.result?.status!=="awaiting_approval")rejectAgentRecord("workspace.approval_result");
    const expectedHash=attempt.status==="settled"&&attempt.result?.output?agentWorkspaceHash(attempt.result.output):null;
    if(attempt.outputHash!==expectedHash)rejectAgentRecord("workspace.result_hash");
  }
  const invocationIds=new Set<string>();
  for(const trace of state.responsibility) {
    if(invocationIds.has(trace.invocationId))rejectAgentRecord("workspace.duplicate_invocation_decision");invocationIds.add(trace.invocationId);
    if(trace.accepted&&trace.code!=="accepted")rejectAgentRecord("workspace.accepted_code");
    if(trace.accepted&&trace.plan.evidenceIds.some((id)=>!state.attempts.some((entry)=>entry.id===id&&entry.agentId===trace.agentId)&&!state.mailbox.some((entry)=>entry.id===id&&entry.agentId===trace.agentId)))rejectAgentRecord("workspace.trace_evidence_owner");
  }
  for(const record of state.mailbox) {
    const trace=state.responsibility.find((entry)=>entry.id===record.traceId);
    if(!trace?.accepted||trace.agentId!==record.agentId||trace.missionId!==record.missionId||trace.plan.action!=="delegate_agent"||trace.plan.recipientAgentId!==record.recipientAgentId)rejectAgentRecord("workspace.mailbox_trace");
    const questionIds=new Set<string>();
    for(const clarification of record.clarifications??[]) {
      if(questionIds.has(clarification.questionMessageId))rejectAgentRecord("workspace.duplicate_peer_question");questionIds.add(clarification.questionMessageId);
      const question=state.messages.find((entry)=>entry.id===clarification.questionMessageId&&entry.agentId===clarification.childAgentId&&entry.missionId===clarification.childMissionId&&entry.purpose==="question");
      const invocation=state.invocations.find((entry)=>entry.id===clarification.invocationId&&entry.agentId===record.agentId&&entry.missionId===record.missionId&&entry.stage==="authoring");
      if(!question||question.text!==clarification.question||!invocation||clarification.childAgentId!==record.recipientAgentId)rejectAgentRecord("workspace.peer_clarification_binding");
      if(clarification.status==="answered"&&(invocation.status!=="settled"||clarification.usageTokens!==invocation.usage?.totalTokens||!clarification.answer))rejectAgentRecord("workspace.peer_clarification_receipt");
    }
    if(record.status==="answered"&&!record.usage)rejectAgentRecord("workspace.mailbox_receipt");
  }
  for(const mission of state.missions) {
    const attempts=state.attempts.filter((entry)=>entry.missionId===mission.id),mailbox=state.mailbox.filter((entry)=>entry.missionId===mission.id),invocations=state.invocations.filter((entry)=>entry.missionId===mission.id);
    if(attempts.filter((entry)=>entry.status!=="settled"&&!entry.userResolved).length>1)rejectAgentRecord("workspace.multiple_unresolved_work");
    if(mailbox.filter((entry)=>entry.status!=="answered").length>1)rejectAgentRecord("workspace.multiple_unresolved_exchanges");
    const calls=invocations.length+attempts.reduce((sum,entry)=>sum+(entry.status==="settled"?entry.result?.usage?.modelCalls??0:0),0)+mailbox.reduce((sum,entry)=>sum+(entry.usage?.modelCalls??0),0);
    const tokens=invocations.reduce((sum,entry)=>sum+(entry.usage?.totalTokens??0),0)+attempts.reduce((sum,entry)=>sum+(entry.status==="settled"?entry.result?.usage?.totalTokens??0:0),0)+mailbox.reduce((sum,entry)=>sum+(entry.usage?.totalTokens??0),0);
    const chargedAttempts=attempts.length+mailbox.reduce((sum,entry)=>sum+(entry.usage?.attempts??0),0);
    if(![calls,tokens,chargedAttempts].every(Number.isSafeInteger)||mission.usage.modelCalls<calls||mission.usage.totalTokens<tokens||mission.usage.attempts<chargedAttempts)rejectAgentRecord("workspace.usage_undercharged");
  }
}
