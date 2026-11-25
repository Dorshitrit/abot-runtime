import { readAgentDecisionConfiguration } from "./decision-validation.js";
import { readAgentPeerClarification } from "./peer-clarification-validation.js";
import { createHash } from "node:crypto";
import type { AgentState } from "./agent-records.js";
import type { AgentWorkRequest, AgentWorkResult } from "./application-contracts.js";
import type { AgentActionPlan, AgentConversationMessage, AgentMailboxRecord, AgentPeerUsage, AgentResponsibilityTrace, AgentWorkAttempt } from "./workspace-records.js";
import type { AgentWorkspaceCommand } from "./workspace-commands.js";
import { isAgentWorkspaceKind } from "./workspace-commands.js";
import { readAgentMissionLimits, rejectAgentRecord, requireAgentFields, requireAgentInteger, requireAgentText, requireAgentTimestamp } from "./record-validation.js";

export function agentWorkspaceHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  })).digest("hex")}`;
}
export const AGENT_WORKSPACE_TEXT_LIMIT = 64_000;
function boundedText(value: unknown, name: string, maximum = AGENT_WORKSPACE_TEXT_LIMIT): asserts value is string {
  requireAgentText(value, name);
  if (value.length > maximum) rejectAgentRecord(name);
}
function nullableText(value: unknown, name: string): void { if (value !== null && typeof value !== "string") rejectAgentRecord(name); }
function stringIds(value: unknown, name: string): void {
  if (!Array.isArray(value) || value.length > 32 || new Set(value).size !== value.length) rejectAgentRecord(name);
  for (const entry of value) boundedText(entry, name, 256);
}
export function readAgentActionPlan(value: unknown): AgentActionPlan {
  const hasReport = value !== null && typeof value === "object" && Object.hasOwn(value, "publicUpdate");
  const record = requireAgentFields(value, ["action", "reason", "sessionId", "recipientAgentId", "evidenceIds", "metCriteriaIds", ...(hasReport ? ["publicUpdate"] : [])], "agentPlan");
  if (hasReport) {
    if (!["start_session", "continue_session", "delegate_agent"].includes(String(record.action))) rejectAgentRecord("agentPlan.publicUpdate_action");
    boundedText(record.publicUpdate, "agentPlan.publicUpdate", 360);
  }
  if (!["answer_user", "read_evidence", "start_session", "continue_session", "ask_user", "wait", "complete", "exhausted", "delegate_agent"].includes(record.action as string)) rejectAgentRecord("agentPlan.action");
  boundedText(record.reason, "agentPlan.reason", 1000);
  nullableText(record.sessionId, "agentPlan.sessionId"); nullableText(record.recipientAgentId, "agentPlan.recipientAgentId");
  if ((record.action === "continue_session" || record.action === "read_evidence") !== (record.sessionId !== null)) rejectAgentRecord("agentPlan.session_target");
  if ((record.action === "delegate_agent") !== (record.recipientAgentId !== null)) rejectAgentRecord("agentPlan.peer_target");
  stringIds(record.evidenceIds, "agentPlan.evidenceIds"); stringIds(record.metCriteriaIds, "agentPlan.metCriteriaIds");
  return structuredClone(record) as AgentActionPlan;
}
export function readAgentWorkResult(value: unknown): AgentWorkResult {
  const record = requireAgentFields(value, ["status", "output", "error", "usage", "receiptId"], "agentWorkResult");
  if (!["running", "awaiting_approval", "completed", "failed", "cancelled", "unknown"].includes(record.status as string)) rejectAgentRecord("agentWorkResult.status");
  for (const key of ["output", "error", "receiptId"]) nullableText(record[key], `agentWorkResult.${key}`);
  if (record.usage !== null) {
    const usage = requireAgentFields(record.usage, ["modelCalls", "totalTokens"], "agentWorkResult.usage");
    requireAgentInteger(usage.modelCalls, 0, "agentWorkResult.calls"); requireAgentInteger(usage.totalTokens, 0, "agentWorkResult.tokens");
  }
  return structuredClone(record) as AgentWorkResult;
}
export function readAgentPeerUsage(value: unknown): AgentPeerUsage | null {
  if (value === null) return null;
  const record = requireAgentFields(value, ["modelCalls", "totalTokens", "attempts", "clarificationRounds"], "peerUsage");
  for (const key of Object.keys(record)) requireAgentInteger(record[key], 0, `peerUsage.${key}`);
  return structuredClone(record) as AgentPeerUsage;
}
function validateAgentMessage(value: unknown, state: AgentState): asserts value is AgentConversationMessage {
  const record = requireAgentFields(value, ["id", "agentId", "missionId", "role", "source", "text", "createdAt",...(value&&typeof value==="object"?["purpose","traceId","inputIntent","inReplyTo","correctableAttemptId","withdrawnAttemptId"].filter((key)=>Object.hasOwn(value,key)):[])], "agentMessage");
  for (const key of ["id", "agentId", "missionId"]) boundedText(record[key], `agentMessage.${key}`);
  // A recovered reply can exceed the normal message cap only when it exactly matches its owned work receipt.
  const savedOutput = typeof record.text === "string" && record.text.length > AGENT_WORKSPACE_TEXT_LIMIT && record.role === "assistant" &&
    record.purpose === "reply" && record.source === null && state.attempts.some(entry =>
      String(record.id).replace(/^#+/u, "") === "work-result:" + entry.id && entry.agentId === record.agentId && entry.missionId === record.missionId &&
      entry.status === "settled" && entry.result?.usage && entry.result.output === record.text);
  if (!savedOutput) boundedText(record.text, "agentMessage.text");
  if (!["user", "assistant", "abot"].includes(record.role as string)) rejectAgentRecord("agentMessage.role");
  if(Object.hasOwn(record,"purpose")&&!["request","conversation","clarification","reply","question"].includes(record.purpose as string)) rejectAgentRecord("agentMessage.purpose");
  if(Object.hasOwn(record,"inputIntent")&&(record.inputIntent!=="auto"||record.role!=="user"))rejectAgentRecord("agentMessage.inputIntent");
  if(Object.hasOwn(record,"inReplyTo")){requireAgentText(record.inReplyTo,"agentMessage.inReplyTo");if(record.purpose!=="clarification"||record.inputIntent!=="auto")rejectAgentRecord("agentMessage.reply_binding");}
  if (Object.hasOwn(record, "correctableAttemptId")) {
    boundedText(record.correctableAttemptId, "agentMessage.correctableAttemptId", 256);
    if (record.role !== "user" || record.source !== null || record.inputIntent !== "auto" || record.purpose !== "conversation")
      rejectAgentRecord("agentMessage.correction_source");
  }
  if (Object.hasOwn(record, "withdrawnAttemptId")) {
    boundedText(record.withdrawnAttemptId, "agentMessage.withdrawnAttemptId", 256);
    if (record.role !== "assistant" || record.source !== null || record.purpose !== "reply") rejectAgentRecord("agentMessage.withdrawal_reply");
  }
  if(Object.hasOwn(record,"traceId"))requireAgentText(record.traceId,"agentMessage.traceId");
  if(record.purpose==="question"&&(record.role!=="assistant"||!record.traceId))rejectAgentRecord("agentMessage.question_trace");
  if (record.source !== null) {
    const source = requireAgentFields(record.source, ["agentId", "missionId", "correlationId"], "agentMessage.source");
    for (const key of Object.keys(source)) boundedText(source[key], `agentMessage.source.${key}`, 256);
    if (record.role !== "abot") rejectAgentRecord("agentMessage.source_role");
  }
  requireAgentTimestamp(record.createdAt, "agentMessage.createdAt");
}
export function readAgentWorkAttempt(value: unknown): AgentWorkAttempt {
  const record = requireAgentFields(value, ["id", "agentId", "missionId", "agentRevision", "missionRevision", "request", "mode", "fingerprint", "status", "claimId", "result", "outputHash", "userResolved", "createdAt", "updatedAt"], "agentAttempt");
  for (const key of ["id", "agentId", "missionId"]) boundedText(record[key], `agentAttempt.${key}`, 256);
  for (const key of ["agentRevision", "missionRevision"]) requireAgentInteger(record[key], 1, `agentAttempt.${key}`);
  const request = requireAgentFields(record.request, ["agentId", "missionId", "attemptId", "requestId", "sessionId", "assignment", "modelProfileId", "toolPermissionMode"], "agentAttempt.request");
  for (const key of Object.keys(request)) boundedText(request[key], `agentAttempt.request.${key}`);
  if (!["ask", "full_access", "full_plus"].includes(request.toolPermissionMode as string)) rejectAgentRecord("agentAttempt.permission");
  if (request.agentId !== record.agentId || request.missionId !== record.missionId || request.attemptId !== record.id) rejectAgentRecord("agentAttempt.identity");
  if (record.fingerprint !== agentWorkspaceHash(record.request)) rejectAgentRecord("agentAttempt.fingerprint");
  if (!["new", "continue"].includes(record.mode as string)) rejectAgentRecord("agentAttempt.mode");
  if (!["prepared", "claimed", "running", "awaiting_approval", "settled", "unknown"].includes(record.status as string)) rejectAgentRecord("agentAttempt.status");
  nullableText(record.claimId, "agentAttempt.claimId"); nullableText(record.outputHash, "agentAttempt.outputHash");
  if (record.status === "prepared" && record.claimId !== null) rejectAgentRecord("agentAttempt.premature_claim");
  if (record.status !== "prepared" && record.status !== "unknown" && record.claimId === null) rejectAgentRecord("agentAttempt.claim_missing");
  if (typeof record.userResolved !== "boolean") rejectAgentRecord("agentAttempt.userResolved");
  if (record.result !== null) readAgentWorkResult(record.result);
  if (record.status === "settled" && !(record.result && ["completed", "failed", "cancelled"].includes((record.result as AgentWorkResult).status))) rejectAgentRecord("agentAttempt.terminal_result_missing");
  requireAgentTimestamp(record.createdAt, "agentAttempt.createdAt"); requireAgentTimestamp(record.updatedAt, "agentAttempt.updatedAt");
  return structuredClone(record) as AgentWorkAttempt;
}
function validateResponsibilityTrace(value: unknown): asserts value is AgentResponsibilityTrace {
  const record = requireAgentFields(value, ["id", "agentId", "missionId", "agentRevision", "missionRevision", "invocationId", "plan", "accepted", "code", "createdAt"], "agentTrace");
  for (const key of ["id", "agentId", "missionId", "invocationId", "code"]) boundedText(record[key], `agentTrace.${key}`, 256);
  for (const key of ["agentRevision", "missionRevision"]) requireAgentInteger(record[key], 1, `agentTrace.${key}`);
  if (typeof record.accepted !== "boolean") rejectAgentRecord("agentTrace.accepted");
  readAgentActionPlan(record.plan); requireAgentTimestamp(record.createdAt, "agentTrace.createdAt");
}
export function readAgentMailboxRecord(value: unknown): AgentMailboxRecord {
  const record = requireAgentFields(value, ["id", "agentId", "missionId", "missionRevision", "traceId", "recipientAgentId", "assignment", "limits", "status", "outcome", "output", "usage", "createdAt", "updatedAt",...(value&&typeof value==="object"&&Object.hasOwn(value,"clarifications")?["clarifications"]:[])], "agentMailbox");
  for (const key of ["id", "agentId", "missionId", "traceId", "recipientAgentId", "assignment"]) boundedText(record[key], `agentMailbox.${key}`);
  requireAgentInteger(record.missionRevision, 1, "agentMailbox.missionRevision"); readAgentMissionLimits(record.limits);
  if (!["pending", "answered", "unknown"].includes(record.status as string)) rejectAgentRecord("agentMailbox.status");
  if(record.outcome!==null&&!["completed","exhausted","cancelled"].includes(record.outcome as string)) rejectAgentRecord("agentMailbox.outcome");
  if(Object.hasOwn(record,"clarifications")){if(!Array.isArray(record.clarifications))rejectAgentRecord("agentMailbox.clarifications");for(const item of record.clarifications)readAgentPeerClarification(item);}
  nullableText(record.output, "agentMailbox.output"); readAgentPeerUsage(record.usage);
  if (record.status === "pending" && (record.output !== null || record.usage !== null || record.outcome !== null)) rejectAgentRecord("agentMailbox.pending_result");
  requireAgentTimestamp(record.createdAt, "agentMailbox.createdAt"); requireAgentTimestamp(record.updatedAt, "agentMailbox.updatedAt");
  return structuredClone(record) as AgentMailboxRecord;
}
const COMMAND_FIELDS: Record<AgentWorkspaceCommand["kind"], readonly string[]> = {
  publish_conversation_reply:["missionId","messageId","invocationId","text"],
  reserve_conversation_reply:["missionId","messageId","invocationId","reservedTokens","agentRevision","missionRevision","configuration"],
  reserve_peer_clarification:["missionId","exchangeId","childMissionId","questionMessageId","clarificationId","invocationId","reservedTokens","agentRevision","missionRevision","configuration"],
  settle_peer_clarification:["missionId","exchangeId","clarificationId","outcome","text"],
  open_agent_turn: ["missionId", "messageId", "text", "intent", "limits", "source"], append_agent_message: ["missionId", "messageId", "role", "text"],
  publish_recorded_work_result:["missionId","missionRevision","attemptId","reason"],
  reject_agent_plan:["missionId","traceId","invocationId"],
  record_agent_plan: ["missionId", "traceId", "invocationId", "plan"], prepare_agent_work: ["attempt", "traceId"],
  claim_agent_work: ["attemptId", "claimId"], observe_agent_work: ["attemptId", "result"],
  finish_agent_turn: ["missionId", "status", "reason"], resume_agent_turn: ["missionId", "text"], mark_agent_waiting: ["missionId", "reason"],
  ask_agent_user:["missionId","traceId","messageId","text"],
  reconcile_cancelled_exchange: ["exchangeId"],
  prepare_agent_exchange: ["record"], settle_agent_exchange: ["exchangeId", "output", "usage", "outcome"],
};
export function readAgentWorkspaceCommand(value: unknown): AgentWorkspaceCommand {
  const kind = (value as {kind?:unknown} | null)?.kind;
  if (!isAgentWorkspaceKind(kind)) rejectAgentRecord("workspaceCommand.kind");
  const optional: Partial<Record<AgentWorkspaceCommand["kind"], readonly string[]>> = {
    finish_agent_turn:["traceId","messageId","text"], open_agent_turn:["expectedAgentRevision","questionId"],
    append_agent_message:["purpose"], publish_conversation_reply:["withdrawAttemptId"],
  };
  const key = kind as AgentWorkspaceCommand["kind"];
  const extras = value && typeof value === "object" ? (optional[key] ?? []).filter(field => Object.hasOwn(value,field)) : [];
  const record = requireAgentFields(value, ["kind", "agentId", ...COMMAND_FIELDS[key], ...extras], "workspaceCommand");
  for (const key of ["agentId", "missionId", "messageId", "text", "traceId", "invocationId", "attemptId", "claimId", "reason", "exchangeId"])
    if (Object.hasOwn(record, key) && record[key] !== null) boundedText(record[key], `workspaceCommand.${key}`);
  if(kind==="publish_recorded_work_result") requireAgentInteger(record.missionRevision,1,"workspaceCommand.missionRevision");
  if (kind === "publish_conversation_reply" && Object.hasOwn(record, "withdrawAttemptId")) {
    boundedText(record.withdrawAttemptId, "workspaceCommand.withdrawAttemptId", 256);
    requireAgentText(record.invocationId, "workspaceCommand.invocationId");
  }
  if(kind==="reserve_conversation_reply") {
    for(const field of ["reservedTokens","agentRevision","missionRevision"])requireAgentInteger(record[field],1,`conversation.${field}`);
    readAgentDecisionConfiguration(record.configuration);
  }
  if(kind==="reserve_peer_clarification") {
    for(const field of ["reservedTokens","agentRevision","missionRevision"])requireAgentInteger(record[field],1,`peerClarification.${field}`);
    for(const field of ["childMissionId","questionMessageId","clarificationId"])requireAgentText(record[field],`peerClarification.${field}`);
    readAgentDecisionConfiguration(record.configuration);
  }
  if(kind==="settle_peer_clarification") {requireAgentText(record.clarificationId,"peerClarification.id");if(!["answer","needs_user","unknown"].includes(record.outcome as string))rejectAgentRecord("peerClarification.outcome");}
  if (kind === "open_agent_turn") {
    if(Object.hasOwn(record,"expectedAgentRevision")) requireAgentInteger(record.expectedAgentRevision,1,"workspaceCommand.expectedAgentRevision");
    if(Object.hasOwn(record,"questionId"))requireAgentText(record.questionId,"workspaceCommand.questionId");
    if(!["task","message","auto"].includes(record.intent as string)) rejectAgentRecord("workspaceCommand.intent");
    if(record.limits!==null)readAgentMissionLimits(record.limits);
    if (record.source !== null) { const source = requireAgentFields(record.source, ["agentId", "missionId", "correlationId"], "workspaceCommand.source"); for (const key of Object.keys(source)) boundedText(source[key], `source.${key}`, 256); }
  }
  if (kind === "append_agent_message" && !["user", "assistant", "abot"].includes(record.role as string)) rejectAgentRecord("workspaceCommand.role");
  if(kind==="append_agent_message"&&Object.hasOwn(record,"purpose")&&!["conversation","clarification","reply"].includes(record.purpose as string)) rejectAgentRecord("workspaceCommand.purpose");
  if (kind === "record_agent_plan") readAgentActionPlan(record.plan);
  if (kind === "prepare_agent_work") readAgentWorkAttempt(record.attempt);
  if (kind === "observe_agent_work") readAgentWorkResult(record.result);
  if(kind==="finish_agent_turn"&&Object.hasOwn(record,"messageId")!==Object.hasOwn(record,"text")) rejectAgentRecord("workspaceCommand.final_message");
  if (kind === "finish_agent_turn" && !["completed", "exhausted"].includes(record.status as string)) rejectAgentRecord("workspaceCommand.status");
  if (kind === "prepare_agent_exchange") readAgentMailboxRecord(record.record);
  if (kind === "settle_agent_exchange") { if(record.outcome!==null&&!["completed","exhausted","cancelled"].includes(record.outcome as string)) rejectAgentRecord("workspaceCommand.outcome"); nullableText(record.output, "workspaceCommand.output"); readAgentPeerUsage(record.usage); }
  return structuredClone(record) as AgentWorkspaceCommand;
}
export function validateAgentWorkspaceState(state: AgentState, deletedAgents: ReadonlySet<string>): void {
  const ids = new Set<string>(), requestIds = new Set<string>();
  function ownership(record: {agentId:string;missionId:string}) {
    if (!state.agents.some((agent) => agent.id === record.agentId) || !state.missions.some((mission) => mission.id === record.missionId && mission.agentId === record.agentId)) rejectAgentRecord("workspace.owner");
  }
  for (const message of state.messages) { validateAgentMessage(message, state); ownership(message); if (ids.has(message.id)) rejectAgentRecord("workspace.duplicate_message"); ids.add(message.id); }
  ids.clear();
  for (const attempt of state.attempts) {
    readAgentWorkAttempt(attempt); ownership(attempt);
    if (ids.has(attempt.id) || requestIds.has(attempt.request.requestId)) rejectAgentRecord("workspace.duplicate_attempt");
    ids.add(attempt.id); requestIds.add(attempt.request.requestId);
    if (!state.sessions.some((session) => session.sessionId === attempt.request.sessionId && session.agentId === attempt.agentId)) rejectAgentRecord("workspace.attempt_session");
    const mission = state.missions.find((entry) => entry.id === attempt.missionId)!;
    if (attempt.missionRevision > mission.revision || attempt.agentRevision > state.agents.find((entry) => entry.id === attempt.agentId)!.revision) rejectAgentRecord("workspace.future_attempt");
  }
  ids.clear();
  for (const trace of state.responsibility) {
    validateResponsibilityTrace(trace); ownership(trace);
    if (ids.has(trace.id)) rejectAgentRecord("workspace.duplicate_trace"); ids.add(trace.id);
    const invocation = state.invocations.find((entry) => entry.id === trace.invocationId);
    if (!invocation || invocation.agentId !== trace.agentId || invocation.missionId !== trace.missionId || invocation.agentRevision !== trace.agentRevision || invocation.missionRevision !== trace.missionRevision) rejectAgentRecord("workspace.trace_invocation");
  }
  ids.clear();
  for (const record of state.mailbox) {
    readAgentMailboxRecord(record); ownership(record);
    if (ids.has(record.id)) rejectAgentRecord("workspace.duplicate_exchange"); ids.add(record.id);
    if (record.agentId !== "abot" || record.recipientAgentId === record.agentId) rejectAgentRecord("workspace.mailbox_target");
    if (deletedAgents.has(record.recipientAgentId)) {
      if (record.status !== "answered" || !record.usage || !record.outcome || record.clarifications !== undefined)
        rejectAgentRecord("workspace.deleted_peer_receipt");
    } else if (!state.agents.some(entry => entry.id === record.recipientAgentId)) rejectAgentRecord("workspace.mailbox_target");
  }
}
