import { escapeHtml } from "../../lib/text-format.js";
import {
  dashboardTimePresentation,
  projectDashboardConversations,
} from "../../lib/dashboard-presentation.js";
import { dashboardIcon } from "./icons.js";

function conversationRow(session) {
  const time = dashboardTimePresentation(session.updatedAt);
  const metadata = [];
  if (session.readStateUnavailable) metadata.push("Unread status unavailable");
  if (session.unreadCount > 0)
    metadata.push(
      `${session.unreadCount} unread ${session.unreadCount === 1 ? "message" : "messages"}`,
    );
  if (time) metadata.push(time.label);
  return `<button type="button" class="home-recent-row${session.unreadCount > 0 ? " has-unread" : ""}" data-dashboard-action="conversation" data-session-id="${escapeHtml(session.id)}">
    <span class="home-row-copy"><span class="home-row-title" dir="auto">${escapeHtml(session.title)}</span><span class="home-row-detail" title="${escapeHtml(time?.title || "")}">${escapeHtml(metadata.join(" · ") || "No messages yet")}</span></span>
  </button>`;
}

function conversationsState({ loading, error }) {
  if (loading)
    return '<p class="home-panel-state" role="status">Loading conversations…</p>';
  if (error)
    return '<div class="home-panel-state" role="alert"><p>Recent conversations could not be loaded.</p><button type="button" class="home-text-button" data-dashboard-action="refresh">Try again</button></div>';
  return `<div class="home-panel-empty" role="status">${dashboardIcon("conversations")}<strong>A fresh start.</strong><p>Your conversations will appear here.</p></div>`;
}

function unreadAvailabilityNotice({ conversations, hasUnavailableReadState }) {
  if (!hasUnavailableReadState) return "";
  if (conversations.some((session) => session.readStateUnavailable)) return "";
  return '<p class="home-refresh-feedback" role="status">Unread status unavailable</p>';
}

export function renderDashboardConversations({
  sessions = [],
  loading = false,
  error = "",
}) {
  const projection = projectDashboardConversations(sessions, 3);
  const {
    recentConversations: conversations,
    unreadCount,
    hasUnavailableReadState,
  } = projection;
  const badge =
    unreadCount > 0 && !hasUnavailableReadState
      ? `<span class="home-unread-count" aria-label="${unreadCount} unread messages">${unreadCount}</span>`
      : "";
  const header = `<header class="home-panel-header"><h2>Recent conversations${badge}</h2><button type="button" class="home-text-button" data-dashboard-action="conversations">Open chats${dashboardIcon("arrow")}</button></header>`;
  if (!conversations.length)
    return header + conversationsState({ loading, error });
  const feedback = error
    ? '<p class="home-refresh-feedback" role="status">Conversations could not be refreshed. <button type="button" class="home-text-button" data-dashboard-action="refresh">Try again</button></p>'
    : "";
  return `${header}<div class="home-panel-rows" aria-label="Recent conversations including unread">${conversations.map(conversationRow).join("")}</div>${unreadAvailabilityNotice({ conversations, hasUnavailableReadState })}${feedback}`;
}
