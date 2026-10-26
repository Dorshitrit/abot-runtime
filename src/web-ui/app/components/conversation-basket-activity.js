import { createSkillActivityIcon } from "./conversation-skill-activity.js";

const STATUS_LABELS = Object.freeze({
  matched: "Matches",
  started: "Started",
  completed: "Completed",
  unavailable: "Unavailable",
});

/** Recorded source activity stays distinct from tool executions and Skill reads. */
export function createConversationBasketActivity({
  documentRoot = document,
  activities = [],
} = {}) {
  if (activities.length === 0) return null;
  const section = documentRoot.createElement("section");
  section.className = "conversation-basket-collection";
  section.setAttribute("aria-label", "Information basket activity");
  const heading = documentRoot.createElement("h3");
  heading.className = "conversation-basket-heading";
  heading.appendChild(createSkillActivityIcon(documentRoot));
  const title = documentRoot.createElement("span");
  title.textContent = "Sources";
  heading.appendChild(title);
  const list = documentRoot.createElement("ol");
  list.className = "conversation-basket-items";
  for (const activity of activities) {
    const row = documentRoot.createElement("li");
    row.className = "conversation-basket-activity";
    row.dataset.status = activity.status;
    const label = documentRoot.createElement("span");
    label.className = "conversation-basket-label";
    label.setAttribute("dir", "auto");
    label.textContent = activity.label;
    const status = documentRoot.createElement("span");
    status.className = "conversation-basket-status";
    status.textContent = STATUS_LABELS[activity.status];
    row.append(label, status);
    list.appendChild(row);
  }
  section.append(heading, list);
  return section;
}
