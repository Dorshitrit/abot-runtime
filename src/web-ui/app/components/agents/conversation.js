import { renderAgentBudgetStop } from "./budget-stop.js";
import { renderDelegatedApprovalAttention } from "./approval-attention.js";
import { agentPlanRecoveryNotice } from "../../lib/agent-plan-recovery.js";
import { formatToolName } from "../../lib/event-presentation.js";
import { escapeHtml as html, escapeAttribute as attr, renderMarkdown } from "../../lib/text-format.js";
import { isPausedAgentTask, isStandaloneAgentConversation, pausedAgentChatBlock, requiresAgentRecoveryBudget } from "./recovery.js";
export function renderAgentConversation() {
  return `<header class="agents-conversation-head">
    <span class="agents-status-dot" aria-hidden="true"></span>
    <strong data-agents-chat-name></strong><small data-agents-chat-status></small>
    <details class="agents-manage" data-agents-manage>
      <summary>Manage</summary>
      <div class="agents-manage-panel">
        <div class="agents-manage-task" data-agents-task-controls></div>
        <details class="agents-session-index" data-agents-session-index hidden>
          <summary>Work sessions <span data-agents-session-count></span></summary>
          <div data-agents-sessions></div>
          <nav class="agents-session-pages" data-session-pages hidden aria-label="Work session pages">
            <button type="button" class="agents-plain" data-session-page="newer" aria-label="Newer work sessions">Newer</button>
            <button type="button" class="agents-plain" data-session-page="older" aria-label="Older work sessions">Older</button>
          </nav>
        </details>
        <button type="button" class="agents-plain" data-agents-action="schedules">Schedules</button>
        <button type="button" class="agents-plain" data-agents-action="configure">Configure agent</button>
        <button type="button" class="agents-plain agents-recovered-drafts" data-agents-action="recovered-drafts" hidden>Saved drafts</button>
      </div>
    </details>
    <button type="button" class="agents-close" data-agents-action="close-chat" aria-label="Return agent to orbit">×</button>
  </header>
  <section class="agents-session-preview" data-agents-session-preview hidden aria-label="Work session preview"></section>
  <div class="agents-conversation-messages" data-agents-messages role="log" aria-label="Agent conversation"></div>
  <div class="agents-response-status" data-agents-response-status role="status" aria-atomic="true"></div>
  <div data-agents-approvals></div>
  <div class="agents-recovery" data-agents-recovery hidden></div>
  <div class="agents-task-state" data-agents-task-state></div>
  <p class="agents-error" data-agents-chat-error role="alert"></p>
  <form class="agents-compose" data-agents-form="message">
    <label class="sr-only" for="agentsMessageInput">Message your agent</label>
    <textarea id="agentsMessageInput" name="message" dir="auto" spellcheck="false" enterkeyhint="send" rows="1" maxlength="12000" placeholder="Talk to your agent…"></textarea>
    <button class="agents-primary" type="submit" aria-label="Send message">↑</button>
  </form>`;
}
export function renderAgentMessages(messages = []) {
  if (!messages.length) return "";
  return messages.map((message) => {
    const isUser = message.role === "user";
    const author = isUser ? "You" : message.role === "abot" ? "ABot" : "Agent";
    return `<article class="agents-message${isUser ? " is-user" : ""}" data-message-id="${attr(message.id)}">
      <span class="${isUser ? "sr-only" : "agents-message-author"}">${html(author)}</span>
      <div class="markdown-body" dir="auto">${renderMarkdown(message.text || message.content || "")}</div>
    </article>`;
  }).join("");
}
export function renderAgentApprovals(approvals = []) {
  return approvals.map((item, index) => {
    const request = item.request || item.presentation || item;
    const tool = formatToolName(request.call?.tool || request.tool);
    return `<section class="agents-approval"><strong>${html(tool || "Session")} approval required</strong><p dir="auto">${html(request.description || request.summary || request.call?.clientStatus || "The work session is waiting for your approval.")}</p><div data-agent-approval-details="${index}" aria-label="Action details"></div><div class="agents-approval-actions"><button type="button" class="agents-primary" data-agent-approval="${index}" data-approved="true">Approve</button><button type="button" class="agents-plain" data-agent-approval="${index}" data-approved="false">Decline</button></div></section>`;
  }).join("");
}
export function renderAgentTaskState(detail) {
  if (!detail) return "";
  const budgetStop = renderAgentBudgetStop(detail);
  if (budgetStop) return budgetStop;
  const delegatedApproval = renderDelegatedApprovalAttention(detail);
  if (delegatedApproval) return delegatedApproval;
  const mission = detail.mission;
  const status = detail.status || "idle";
  if (status === "awaiting_user_decision" && detail.pendingUserQuestionId) {
    return "";
  }
  if (status === "awaiting_user_decision" && isStandaloneAgentConversation(detail)) {
    const reason = mission?.waitingReason === "agents_plan_rejected_conversation_cannot_dispatch"
      ? "Your agent paused before replying."
      : "Your agent is waiting for your input.";
    return `<span>${reason}</span><button type="button" class="agents-plain" data-agents-action="resume">Continue conversation</button>`;
  }
  if (isPausedAgentTask(detail)) {
    const block = pausedAgentChatBlock(detail);
    const recordedReason = mission?.waitingReason;
    const reason = block || agentPlanRecoveryNotice(mission, detail.attempts, detail.planRecoveryStatus)
      || (recordedReason && !recordedReason.startsWith("agents_") ? recordedReason : "Choose how to continue this task.");
    const newBudget = requiresAgentRecoveryBudget(detail);
    const resume = !block || newBudget
      ? `<button type="button" class="agents-primary" data-agents-action="resume">${newBudget ? "Review task &amp; budget" : "Continue task…"}</button>` : "";
    return `<section class="agents-paused-task" aria-label="Paused task">
      <div role="status"><strong>Task paused</strong><p>${html(reason)}</p></div>
      <div class="agents-pause-actions">${resume}<button type="button" class="agents-plain" data-agents-action="cancel">End task</button></div>
    </section>`;
  }
  if (detail.recovery?.recordedWorkDelivery === "empty") return "<span>Task ended. The work session returned no public response.</span>";
  if (detail.recovery?.recordedWorkDelivery === "output") return "<span>Task ended. The work session’s response is in the conversation.</span>";
  if (status === "failed") return `<span>${html(mission?.waitingReason || "The last task needs attention.")}</span>`;
  return "";
}
export function renderTaskControls(detail) {
  if (!detail?.mission || !["active", "awaiting_user_decision"].includes(detail.mission.status)) return "";
  if (isPausedAgentTask(detail)) return "";
  const button = (action, label) => `<button type="button" class="agents-plain" data-agents-action="${action}">${label}</button>`;
  if (detail.status === "awaiting_user_decision" || !detail.hasWork) {
    return button("cancel", detail.pendingUserQuestionId || isStandaloneAgentConversation(detail) ? "End turn" : "Stop task");
  }
  return button("steer", "Pause and edit task") + button("pause", "Pause task") + button("cancel", "Stop task");
}
export function workSessionStatus(attempt) {
  if (!attempt) return "";
  const status = attempt.status === "settled" ? attempt.result?.status : attempt.status;
  return ({ prepared: "Preparing", claimed: "Submitted", running: "Working", awaiting_approval: "Awaiting approval",
    completed: "Completed", cancelled: "Stopped", failed: "Failed", unknown: "Outcome unknown" })[status] || "";
}
// Bind an older page to its end in the append-only session index. A new session cannot shift that page.
const sessionsPerPage = 6;
export function agentSessionPage(sessions = [], end = null) {
  const count = sessions.length;
  const upper = end === null ? count : Math.min(end, count);
  const lower = Math.max(0, upper - sessionsPerPage);
  return {
    sessions: sessions.slice(lower, upper),
    older: lower > 0 ? lower : null,
    newer: upper < count ? Math.min(count, upper + sessionsPerPage) : null,
  };
}

export function renderAgentSessions(sessions = [], attempts = []) {
  const latestAttempt = new Map(attempts.map((attempt) => [attempt.request.sessionId, attempt]));
  return sessions.toReversed().map((session) => {
    const status = workSessionStatus(session.status ? session : latestAttempt.get(session.sessionId));
    const purpose = session.purpose?.trim() || "Work session";
    const title = purpose.length > 160 ? purpose.slice(0, 159).trimEnd() + "…" : purpose;
    return `<button type="button" class="agents-plain agents-session-row" data-agent-session="${attr(session.sessionId)}">
      <bdi dir="auto">${html(title)}</bdi>${status ? `<small>${html(status)}</small>` : ""}</button>`;
  }).join("");
}
