const previewSessionLimit = 5;

function isSearchingProjectSessions(query) {
  return Boolean(String(query ?? "").trim());
}

function canExpandProjectSessions(sessions, query) {
  if (isSearchingProjectSessions(query)) return false;
  return sessions.length > previewSessionLimit;
}

export function renderProjectSessionPreview({
  content, group, query, expanded, createSessionItem, onToggleExpanded,
  documentRoot,
}) {
  const rows = documentRoot.createElement("div");
  rows.className = "project-session-rows";
  rows.id = content.id + "-rows";
  const items = group.sessions.map((session) => createSessionItem(session));
  for (const item of items) rows.appendChild(item);
  content.appendChild(rows);

  function setOverflowVisible(showAll) {
    for (const [index, item] of items.entries()) {
      item.hidden = !showAll && index >= previewSessionLimit;
    }
  }

  setOverflowVisible(expanded || isSearchingProjectSessions(query));
  if (!canExpandProjectSessions(group.sessions, query)) return;
  const toggle = documentRoot.createElement("button");
  toggle.type = "button";
  toggle.className = "project-session-more";
  toggle.setAttribute("aria-controls", rows.id);

  function updateToggle() {
    toggle.textContent = expanded
      ? "Show less"
      : `Show more (${items.length - previewSessionLimit})`;
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-label", `${toggle.textContent} conversations in ${group.name}`);
  }

  updateToggle();
  toggle.addEventListener("click", () => {
    expanded = !expanded;
    setOverflowVisible(expanded);
    updateToggle();
    onToggleExpanded(group.id, expanded);
  });
  content.appendChild(toggle);
}
