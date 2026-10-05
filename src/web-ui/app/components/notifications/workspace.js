import { createNotificationFocus } from "./focus.js";
import { createNotificationTabs } from "./tabs.js";
import { canLoadOlderNotifications } from "./pagination.js";
import { renderNotificationFeedback } from "./feedback.js";
export { notificationFeedback } from "./feedback.js";
import {
  renderNotificationItem,
  renderNotificationSettings,
} from "./presentation.js";

export function createNotificationsWorkspace({ root, button, badge, actions }) {
  let snapshot;
  const focus = createNotificationFocus(root);
  root.innerHTML = `<div class="notifications-content">
    <nav class="config-category-nav notifications-nav" role="tablist" aria-label="Notification views">
      <button id="notificationsInboxTab" class="config-category-tab active" type="button" role="tab" data-notification-tab="notifications" aria-controls="notificationsInboxPanel" aria-selected="true">Notifications</button>
      <button id="notificationsSettingsTab" class="config-category-tab" type="button" role="tab" data-notification-tab="settings" aria-controls="notificationsSettingsPanel" aria-selected="false" tabindex="-1">Settings</button>
    </nav>
    <div class="config-category-panels">
    <div id="notificationsInboxPanel" class="config-category-panel" role="tabpanel" aria-labelledby="notificationsInboxTab" tabindex="0" data-notification-panel="notifications">
    <div class="notifications-toolbar">
      <div class="notification-filters" role="group" aria-label="Filter notifications">
        <button type="button" data-notification-filter="all" aria-pressed="false">All</button>
        <button type="button" data-notification-filter="unread" aria-pressed="true">Unread</button>
      </div>
      <div class="notification-toolbar-actions">
        <button type="button" data-notification-action="refresh">Refresh</button>
        <button type="button" data-notification-action="read-all">Mark all read</button>
      </div>
    </div>
    <div class="notification-feedback" role="status" aria-live="polite"></div>
    <ul class="notification-list" aria-label="Notification history"></ul>
    <button type="button" class="notification-load-more" data-notification-action="more" hidden>Load older notifications</button>
    </div>
    <div id="notificationsSettingsPanel" class="config-category-panel notification-settings-root" role="tabpanel" aria-labelledby="notificationsSettingsTab" tabindex="0" data-notification-panel="settings" hidden inert></div>
    </div>
  </div>`;
  createNotificationTabs(root);
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
    feedback.innerHTML = renderNotificationFeedback(next, items);
    feedback.classList.toggle("is-error", Boolean(next.error));
    more.hidden = !canLoadOlderNotifications(next);
    settings.innerHTML = renderNotificationSettings(next);
    focus.restore(next.busy || next.loading);
  }
  return { render };
}
