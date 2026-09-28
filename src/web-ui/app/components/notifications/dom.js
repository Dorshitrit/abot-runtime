export function mountNotificationsDom(dom, documentRoot = document) {
  const button = documentRoot.createElement("button");
  button.id = "notificationsWorkspaceButton";
  button.className = "rail-button";
  button.type = "button";
  button.setAttribute("aria-label", "Open notifications");
  button.setAttribute("aria-controls", "notificationsWorkspacePanel");
  button.title = "Notifications";
  button.innerHTML = `<span class="rail-icon" aria-hidden="true"><svg viewBox="0 0 24 24">
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
    </svg><span class="notification-rail-count" hidden></span></span>
    <span class="rail-button-label">Notifications</span>`;
  dom.configWorkspaceButton.before(button);
  const panel = documentRoot.createElement("section");
  panel.id = "notificationsWorkspacePanel";
  panel.className = "workspace-page-panel notifications-workspace-panel";
  panel.hidden = true;
  panel.inert = true;
  panel.setAttribute("aria-labelledby", "notificationsWorkspaceTitle");
  panel.setAttribute("aria-hidden", "true");
  panel.innerHTML = `<header class="workspace-page-header">
    <div class="workspace-page-heading"><h2 id="notificationsWorkspaceTitle">Notifications</h2><p>Updates from your assistant, in one place.</p></div>
    <button type="button" class="workspace-page-back notification-close">Back to chat</button>
    </header><div class="workspace-page-body" data-notifications-root></div>`;
  dom.app.append(panel);
  Object.assign(dom, {
    notificationsWorkspaceButton: button,
    notificationsWorkspacePanel: panel,
    closeNotificationsWorkspaceButton: panel.querySelector(".notification-close"),
    notificationsRoot: panel.querySelector("[data-notifications-root]"),
    notificationsBadge: button.querySelector(".notification-rail-count"),
  });
}
