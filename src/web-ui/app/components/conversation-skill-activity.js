/** Format already-classified runtime Skill activity; keep recorded evidence unchanged. */
export function createConversationSkillActivity({
  documentRoot = document,
  activities = [],
} = {}) {
  if (activities.length === 0) return null;
  const section = documentRoot.createElement("section");
  section.className = "conversation-skill-collection";
  section.setAttribute("aria-label", "Skill activity");
  let inlineList = null;
  for (const activity of activities) {
    const readName = skillReadDisplayName(activity);
    const groupedRead = readName !== null;
    if (!inlineList || !groupedRead) {
      inlineList = createSkillActivityRow(documentRoot, section, groupedRead);
    }
    const item = documentRoot.createElement("li");
    item.className = "conversation-role-skill-activity";
    item.dataset.tone = activity.tone;
    item.setAttribute("dir", "auto");
    item.setAttribute("title", activity.summary);
    const summary = documentRoot.createElement("span");
    summary.className = "conversation-skill-summary";
    summary.textContent = readName ?? activity.summary;
    item.appendChild(summary);
    inlineList.appendChild(item);
    if (!groupedRead) inlineList = null;
  }
  return section;
}

function skillReadDisplayName(activity) {
  if (activity.tone === "failed") return null;
  if (activity.tone === "neutral") return null;
  if (typeof activity.summary !== "string") return null;
  for (const prefix of ["Read Skills: ", "Read skill: "]) {
    if (!activity.summary.startsWith(prefix)) continue;
    const name = activity.summary.slice(prefix.length);
    return name.trim() ? name : null;
  }
  return null;
}

function createSkillActivityRow(documentRoot, section, groupedRead) {
  const row = documentRoot.createElement("div");
  row.className = "conversation-skill-inline-row";
  const list = documentRoot.createElement("ul");
  list.className = "conversation-skill-items";
  row.appendChild(createSkillActivityIcon(documentRoot));
  if (groupedRead) {
    const label = documentRoot.createElement("span");
    label.className = "conversation-skill-read-label";
    label.textContent = "Read:";
    row.appendChild(label);
  }
  row.appendChild(list);
  section.appendChild(row);
  return list;
}

export function createSkillActivityIcon(documentRoot) {
  const icon = documentRoot.createElement("span");
  icon.className = "conversation-skill-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5c2.5-.6 4.7-.2 7 1.1 2.3-1.3 4.5-1.7 7-1.1v11c-2.5-.6-4.7-.2-7 1.1-2.3-1.3-4.5-1.7-7-1.1zM10 5.6v11M5.5 8l2 .4M12.5 8.4l2-.4M5.5 11l2 .4M12.5 11.4l2-.4"/></svg>';
  return icon;
}
