export function renderSessionSidebarSections({
  root, sessions, archivedCount, showingArchived, onToggleArchived,
  isPinned, createSessionItem, renderGroups, hasConversations,
}) {
  let itemIndex = 0;
  const createItem = (session) => createSessionItem(session, itemIndex++);
  if (showingArchived) {
    const notice = document.createElement("p");
    notice.className = "session-archive-notice";
    notice.textContent = "Archived in this browser and environment. Restore a conversation from its menu.";
    root.appendChild(notice);
  }
  const pinned = sessions.filter((session) => isPinned(session.id));
  const regular = sessions.filter((session) => !isPinned(session.id));
  if (pinned.length) {
    const heading = document.createElement("div");
    heading.className = "project-section-heading pinned-conversations-heading";
    heading.textContent = "Pinned";
    root.appendChild(heading);
    for (const session of pinned) root.appendChild(createItem(session));
  }
  const grouped = renderGroups({ root, sessions: regular, createSessionItem: createItem });
  if (!grouped) {
    for (const session of regular) root.appendChild(createItem(session));
    if (sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state sidebar-empty-state compact";
      empty.innerHTML = hasConversations
        ? "<strong>No matches</strong><span>Try a different conversation name or message.</span>"
        : "<strong>No conversations yet</strong><span>Start a new conversation to keep its history here.</span>";
      root.appendChild(empty);
    }
  }
  if (!archivedCount && !showingArchived) return;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "session-archive-toggle";
  toggle.title = "Conversations archived in this browser and environment";
  toggle.textContent = showingArchived ? "Back to conversations" : `Archived (${archivedCount})`;
  toggle.setAttribute("aria-pressed", String(showingArchived));
  toggle.addEventListener("click", onToggleArchived);
  root.appendChild(toggle);
}
