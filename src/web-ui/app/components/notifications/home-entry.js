function hasHomeUnreadNotifications(snapshot) {
  if (!snapshot.supported) return false;
  if (!Number.isSafeInteger(snapshot.unreadCount)) return false;
  return snapshot.unreadCount > 0;
}

/** Shares the inbox count without fetching or marking any notification read. */
export function createHomeNotificationsEntry({ homePanel, onOpen }) {
  const header = homePanel?.querySelector(".home-workspace-header");
  if (!header) return { render() {} };
  const button = homePanel.ownerDocument.createElement("button");
  button.setAttribute("type", "button");
  button.className = "home-notifications-entry";
  button.hidden = true;
  button.setAttribute("aria-controls", "notificationsWorkspacePanel");
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
    </svg><span></span><span aria-hidden="true">→</span>`;
  const label = button.querySelector("span");
  button.addEventListener("click", () => {
    if (button.hidden) return;
    onOpen();
  });
  header.append(button);
  return {
    render(snapshot) {
      button.hidden = !hasHomeUnreadNotifications(snapshot);
      if (button.hidden) return;
      const count = snapshot.unreadCount;
      const description = `${count} unread ${count === 1 ? "notification" : "notifications"}`;
      label.textContent = description;
      button.setAttribute("aria-label", `View ${description}`);
    },
  };
}
