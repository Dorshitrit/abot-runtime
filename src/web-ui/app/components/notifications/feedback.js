import { escapeHtml } from "../../lib/text-format.js";
import { hasOlderUnreadNotifications } from "./pagination.js";

function notificationFeedbackState(snapshot, items) {
  if (snapshot.error) return { message: snapshot.error };
  if (!snapshot.supported) return { message: "Notifications are unavailable with this backend." };
  if (items.length) return { message: "" };
  if (snapshot.loading) return { message: "Loading notifications…" };
  if (hasOlderUnreadNotifications(snapshot))
    return { message: "Unread notifications are in older history. Load older notifications to view them." };
  if (snapshot.filter === "unread") return {
    message: "You're all caught up.",
    detail: "No unread notifications. Switch to All to revisit earlier updates.",
    icon: '<circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" />',
  };
  return {
    message: "No notifications yet.",
    detail: "Updates from your chats and automations will appear here.",
    icon: '<path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3Z" /><path d="M10 20h4" />',
  };
}

export function notificationFeedback(snapshot, items) {
  return notificationFeedbackState(snapshot, items).message;
}

export function renderNotificationFeedback(snapshot, items) {
  const state = notificationFeedbackState(snapshot, items);
  if (!state.detail) return escapeHtml(state.message);
  return `<div class="notification-empty-state">
    <span class="notification-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${state.icon}</svg></span>
    <h3>${escapeHtml(state.message)}</h3><p>${escapeHtml(state.detail)}</p>
  </div>`;
}
