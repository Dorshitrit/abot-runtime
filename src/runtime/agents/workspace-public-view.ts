import type { SessionSnapshotMessage } from "../../sessions/types.js";
import type { LocalPendingToolApproval } from "../local-host/request-approval-contracts.js";
import type { AgentApplicationDetail } from "./application-contracts.js";
import { agentPlanRecoveryStatus, latestAgentAttentionId, latestPlanNoticeId } from "./attention.js";
import { visibleAgentReplies } from "./conversation-view.js";

export function agentClientStatus(detail: AgentApplicationDetail) {
  const mission = detail.mission;
  const current = mission ? detail.messages.filter(m => m.agentId === detail.agent.id && m.missionId === mission.id) : [];
  const origin = current[0];
  const active = mission?.status === "active";
  const hasWork = Boolean(active && (detail.attempts.some(a => a.missionId === mission.id) ||
    detail.mailbox.some(e => e.missionId === mission.id) || detail.responsibility.some(t => t.missionId === mission.id &&
      t.accepted && ["start_session", "continue_session", "delegate_agent"].includes(t.plan.action))));
  return { hasWork, thinkingSince: currentThinkingStartedAt(detail, current),
    standaloneConversation: origin?.role === "user" && origin.purpose === "conversation",
    latestVisibleReplyId: latestAgentAttentionId(detail), latestPlanNoticeId: latestPlanNoticeId(detail),
    planRecoveryStatus: agentPlanRecoveryStatus(mission, detail.attempts) };
}

/** Public phase timing for direct and delegated work; no request text is exposed. */
function currentThinkingStartedAt(detail: AgentApplicationDetail, messages: AgentApplicationDetail["messages"]): string | null {
  if (detail.mission?.status !== "active" || detail.status !== "thinking") return null;
  const lastUser = [...messages].reverse().find(message => message.role === "user" && message.source === null &&
    (message.inputIntent === "auto" || message.purpose === "conversation" || message.purpose === "clarification"));
  return lastUser?.createdAt ?? detail.mission.createdAt;
}

export function latestVisibleReply(detail: AgentApplicationDetail) {
  const message = visibleAgentReplies(detail.messages, detail.agent.id).at(-1);
  if (!message) return null;
  const chars = Array.from(message.text.trim());
  return { id: message.id, missionId: message.missionId, text: chars.length <= 240 ? chars.join("") : chars.slice(0, 239).join("") + "…",
    createdAt: message.createdAt };
}

export function agentSessionSummaries(detail: AgentApplicationDetail) {
  const latest = new Map(detail.attempts.map(a => [a.request.sessionId, a]));
  return detail.sessions.map(session => {
    const attempt = latest.get(session.sessionId);
    return { ...session, status: attempt?.status === "settled" ? attempt.result?.status ?? null : attempt?.status ?? null,
      settledAttemptId: attempt?.status === "settled" ? attempt.id : null };
  });
}

export function publicApproval({ sessionId, request, wait }: LocalPendingToolApproval) {
  const { requestId, approvalId, call, meta } = request;
  return { sessionId, request: { requestId, approvalId, call: { tool: call.tool, params: call.params, clientStatus: call.clientStatus },
    ...(meta !== undefined && { meta }) },
    ...(wait && { wait: { generation: wait.generation, waitId: wait.waitId, revision: wait.revision } }) };
}

export function publicSessionMessage(message: SessionSnapshotMessage) {
  const { id, sessionId, role, text, source, createdAt, kind, requestId, cronJobId, cronTitle, triggerType, schedule, initiative, approvalRequest } = message;
  return { id, sessionId, role, text, source, createdAt, kind, requestId, cronJobId, cronTitle, triggerType, schedule,
    ...(initiative && { initiative: { kind: initiative.kind, proposalId: initiative.proposalId, reason: initiative.reason } }),
    ...(message.attachments && { attachments: message.attachments.map(({ id, kind, mimeType, name, size }) => ({ id, kind, mimeType, name, size })) }),
    ...(approvalRequest && { approvalRequest: { kind: approvalRequest.kind, waitId: approvalRequest.waitId, state: approvalRequest.state,
      approvals: approvalRequest.approvals.map(({ approvalId, actionFingerprint, presentation }) => ({ approvalId, actionFingerprint,
        presentation: { description: presentation.description, summary: presentation.summary, tool: presentation.tool } })) } }) };
}
