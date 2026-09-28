import { escapeHtml, escapeAttribute, formatTime } from "../../lib/text-format.js";

export const NOTIFICATION_KIND_LABELS = Object.freeze({
  reply: "Assistant replies",
  failure: "Failures",
  approval: "Approval requests",
  proposal: "Co-worker suggestions",
});

const DELIVERY_LABELS = Object.freeze({
  pending: "Waiting to send",
  submitted: "Sent to computer",
  disabled: "Desktop alerts off",
  unavailable: "Computer unavailable",
  failed: "Desktop alert failed",
  unknown: "Delivery not confirmed",
});

const NOTIFICATION_KIND_ICONS = Object.freeze({
  reply: '<path d="M5 4h14v11H9l-4 4V4Z" /><path d="M9 8h6M9 11h4" />',
  failure: '<path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5M12 17h.01" />',
  approval: '<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" /><path d="m8 12 3 3 5-6" />',
  proposal: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" />',
});

function renderNotificationTimestamp(createdAt) {
  const date = new Date(createdAt);
  const full = escapeAttribute(formatTime(createdAt));
  const short = date.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  return `<time datetime="${escapeAttribute(date.toISOString())}" title="${full}" aria-label="${full}">${escapeHtml(short)}</time>`;
}

function notificationBodyRepeatsTitle(item) {
  return item.body.trim() === item.title.trim();
}

export function notificationSourceUrl(item) {
  if (typeof item?.sourceUrl !== "string") return "";
  if (!item.sourceUrl.startsWith("/")) return "";
  let url;
  try {
    url = new URL(item.sourceUrl, "https://abot.invalid");
  } catch {
    return "";
  }
  if (url.origin !== "https://abot.invalid") return "";
  if (!["/chat", "/learning", "/home", "/notifications"].includes(url.pathname)) return "";
  if (url.searchParams.get("environment") !== item.environmentId) return "";
  return `${url.pathname}${url.search}${url.hash}`;
}

function renderNotificationDeliveryError(delivery) {
  if (!["failed", "unknown", "unavailable"].includes(delivery?.status)) return "";
  if (typeof delivery.error !== "string") return "";
  const error = delivery.error.trim();
  if (!error) return "";
  const message = error.includes("#< CLIXML")
    ? "The computer returned an unreadable error."
    : error;
  return `<p class="notification-delivery-error" dir="auto">${escapeHtml(message)}</p>`;
}

export function renderNotificationItem(item, busy) {
  const read = item.readAt != null;
  const source = notificationSourceUrl(item);
  const label = NOTIFICATION_KIND_LABELS[item.kind] || "Notification";
  const delivery = DELIVERY_LABELS[item.delivery?.status] || "Delivery not confirmed";
  const attributes = `data-notification-id="${escapeAttribute(item.id)}"`;
  const readAction = read ? "Mark unread" : "Mark read";
  const icon = NOTIFICATION_KIND_ICONS[item.kind] || NOTIFICATION_KIND_ICONS.reply;
  const preview = notificationBodyRepeatsTitle(item) ? ""
    : `<span class="notification-item-preview" dir="auto">${escapeHtml(item.body)}</span>`;
  return `<li class="notification-item ${read ? "" : "is-unread"}" ${attributes}>
    <span class="notification-kind-icon" role="img" aria-label="${escapeAttribute(label)}" title="${escapeAttribute(label)}"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></span>
    <details class="notification-item-details" ${attributes}>
      <summary data-notification-detail="${escapeAttribute(item.id)}">
        <span class="notification-item-heading">
          <span class="notification-item-title" role="heading" aria-level="3" dir="auto">${escapeHtml(item.title)}</span>
          ${read ? "" : '<span class="notification-read-state" aria-label="Unread">Unread</span>'}
          <svg class="notification-expand-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 5 5-5 5" /></svg>
        </span>
        ${preview}
      </summary>
      <div class="notification-item-expanded">
        <p dir="auto">${escapeHtml(item.body)}</p>
        <div class="notification-item-meta"><span>${escapeHtml(label)}</span><span>${escapeHtml(delivery)}</span></div>
        ${renderNotificationDeliveryError(item.delivery)}
      </div>
    </details>
    <div class="notification-item-footer">
      ${renderNotificationTimestamp(item.createdAt)}
      <div class="notification-item-actions">
        <button type="button" data-notification-action="read" ${attributes} aria-label="${readAction}" ${busy ? "disabled" : ""}>${readAction}</button>
        ${source ? `<a href="${escapeAttribute(source)}" data-notification-action="open" ${attributes}>Open <span aria-hidden="true">↗</span></a>` : ""}
      </div>
    </div>
  </li>`;
}

export function renderNotificationSettings(snapshot) {
  const preferences = snapshot.preferences;
  if (!preferences) return "";
  const disabled = snapshot.busy ? "disabled" : "";
  const desktop = snapshot.desktop || {};
  const status = desktop.message || (desktop.available
    ? "Computer access is connected. Alerts can arrive while your browser is closed."
    : "Connect Computer access to receive desktop alerts.");
  return `<details class="notification-settings"><summary>Notification settings</summary>
    <div class="notification-settings-body">
      <label class="notification-setting"><span><strong>Desktop notifications</strong>
        <small>Show ABot alerts on this computer.</small></span>
        <input type="checkbox" data-notification-preference="desktopEnabled" ${preferences.desktopEnabled ? "checked" : ""} ${disabled}></label>
      <p class="notification-computer-status" role="status">${escapeHtml(status)}</p>
      <div class="notification-kind-settings"><p>Notify me about</p><div class="notification-kind-options">
        ${Object.entries(NOTIFICATION_KIND_LABELS).map(([kind, label]) =>
          `<label class="notification-setting"><span>${label}</span><input type="checkbox" data-notification-kind="${kind}" ${preferences.kinds?.[kind] ? "checked" : ""} ${disabled}></label>`
        ).join("")}
      </div></div>
      <p class="notification-settings-note">History is always saved. Replies in the active conversation stay silent. System notification settings apply.</p>
    </div></details>`;
}
