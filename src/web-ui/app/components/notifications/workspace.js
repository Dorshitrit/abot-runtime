import { createNotificationFocus } from "./focus.js";
import {
  renderNotificationItem,
  renderNotificationSettings,
} from "./presentation.js";

export function createNotificationsWorkspace({ root, button, badge, actions }) {
  let snapshot;
  const focus = createNotificationFocus(root);
  root.innerHTML = `<div class="notifications-content">
    <div class="notifications-toolbar">
      <div class="notification-filters" role="group" aria-label="Filter notifications">
        <button type="button" data-notification-filter="all" aria-pressed="true">All</button>
        <button type="button" data-notification-filter="unread" aria-pressed="false">Unread</button>
      </div>
      <div class="notification-toolbar-actions">
        <button type="button" data-notification-action="refresh">Refresh</button>
        <button type="button" data-notification-action="read-all">Mark all read</button>
      </div>
    </div>
    <p class="notification-feedback" role="status" aria-live="polite"></p>
    <ul class="notification-list" aria-label="Notification history"></ul>
    <button type="button" class="notification-load-more" data-notification-action="more" hidden>Load older notifications</button>
    <div class="notification-settings-root"></div>
  </div>`;
  const list = root.querySelector(".notification-list");
  const feedback = root.querySelector(".notification-feedback");
  const settings = root.querySelector(".notification-settings-root");
  const more = root.querySelector(".notification-load-more");

  async function handleAction(event) {
    const target = event.target.closest("[data-notification-action], [data-notification-filter]");
    if (!target || !root.contains(target) || target.disabled) return;
    const filter = target.dataset.notificationFilter;
    if (filter) {
      actions.setFilter(filter);
      return;
    }
    const action = target.dataset.notificationAction;
    if (action === "refresh") return actions.refresh();
    if (action === "read-all") return actions.markAllRead();
    if (action === "more") return actions.loadMore();
    const item = snapshot?.items.find((candidate) => candidate.id === target.dataset.notificationId);
    if (!item) return;
    if (action === "read") return actions.markRead(item.id, item.readAt != null ? false : true);
    if (action !== "open") return;
    event.preventDefault();
    return actions.openSource(item);
  }

  root.addEventListener("click", (event) => { void handleAction(event); });
  root.addEventListener("change", (event) => {
    const input = event.target;
    if (!input.matches("input[type=checkbox]")) return;
    if (!snapshot?.preferences || snapshot.busy) return;
    const preferences = {
      ...snapshot.preferences,
      kinds: { ...snapshot.preferences.kinds },
    };
    if (input.dataset.notificationPreference === "desktopEnabled")
      preferences.desktopEnabled = input.checked;
    const kind = input.dataset.notificationKind;
    if (kind) preferences.kinds[kind] = input.checked;
    void actions.savePreferences(preferences);
  });

  function render(next) {
    focus.remember();
    const expandedItems = new Set([...list.querySelectorAll("details[open]")]
      .map((item) => item.dataset.notificationId));
    snapshot = next;
    const count = next.unreadCount;
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? "99+" : String(count);
    button.setAttribute("aria-label", count ? `Open notifications, ${count} unread` : "Open notifications");
    for (const filter of root.querySelectorAll("[data-notification-filter]"))
      filter.setAttribute("aria-pressed", String(filter.dataset.notificationFilter === next.filter));
    for (const control of root.querySelectorAll("button[data-notification-action]"))
      control.disabled = next.busy || next.loading || !next.supported;
    root.querySelector('[data-notification-action="read-all"]').disabled = next.busy || count === 0;
    const items = next.filter === "unread"
      ? next.items.filter((item) => item.readAt == null)
      : next.items;
    list.innerHTML = items.map((item) => renderNotificationItem(item, next.busy)).join("");
    for (const details of list.querySelectorAll("details"))
      details.open = expandedItems.has(details.dataset.notificationId);
    list.setAttribute("aria-busy", String(next.loading));
    feedback.textContent = notificationFeedback(next, items);
    feedback.classList.toggle("is-error", Boolean(next.error));
    more.hidden = !next.nextCursor;
    const expanded = settings.querySelector("details")?.open;
    settings.innerHTML = renderNotificationSettings(next);
    const disclosure = settings.querySelector("details");
    if (disclosure) disclosure.open = Boolean(expanded);
    focus.restore(next.busy || next.loading);
  }
  return { render };
}

export function notificationFeedback(snapshot, items) {
  if (snapshot.error) return snapshot.error;
  if (!snapshot.supported) return "Notifications are unavailable with this backend.";
  if (items.length) return "";
  if (snapshot.loading) return "Loading notifications…";
  if (hasOlderUnreadNotifications(snapshot))
    return "Unread notifications are in older history. Load older notifications to view them.";
  if (snapshot.filter === "unread") return "You're all caught up.";
  return "No notifications yet.";
}

function hasOlderUnreadNotifications(snapshot) {
  if (snapshot.filter !== "unread") return false;
  if (snapshot.unreadCount <= 0) return false;
  return Boolean(snapshot.nextCursor);
}
