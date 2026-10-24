export function createConversationMemoryActivity({
  documentRoot = document,
  activities = [],
} = {}) {
  if (activities.length === 0) return null;
  const section = documentRoot.createElement("section");
  section.className = "conversation-memory-activity";
  section.setAttribute("aria-label", "Memory activity");
  for (const activity of activities) {
    const row = documentRoot.createElement("div");
    row.className = "conversation-memory-row";
    row.dataset.state = activity.state;
    const icon = documentRoot.createElement("span");
    icon.className = "conversation-memory-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="10" cy="4.5" rx="6" ry="2.5"/><path d="M4 4.5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-10M4 9.5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5"/></svg>';
    const label = documentRoot.createElement("span");
    label.className = "conversation-memory-label";
    label.textContent = activity.label;
    row.append(icon, label);
    if (activity.detail) {
      const detail = documentRoot.createElement("span");
      detail.className = "conversation-memory-detail";
      detail.setAttribute("dir", "auto");
      detail.textContent = activity.detail;
      row.appendChild(detail);
    }
    section.appendChild(row);
  }
  return section;
}
