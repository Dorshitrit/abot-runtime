const previewSessionLimit = 5;

function isSearchingProjectSessions(query) {
  return Boolean(String(query ?? "").trim());
}

function canExpandProjectSessions(total, query) {
  if (isSearchingProjectSessions(query)) return false;
  return total > previewSessionLimit;
}

function needsFirstProjectExpansionPage(items, page) {
  if (!page?.nextCursor) return false;
  return items.length <= previewSessionLimit;
}

export function renderProjectSessionPreview({
  content, group, query, expanded, createSessionItem, onToggleExpanded,
  documentRoot, page, onLoadMore = () => {},
}) {
  const rows = documentRoot.createElement("div");
  rows.className = "project-session-rows";
  rows.id = content.id + "-rows";
  const items = group.sessions.map((session) => createSessionItem(session));
  for (const item of items) rows.appendChild(item);
  content.appendChild(rows);
  const searching = isSearchingProjectSessions(query);
  const total = page?.total ?? items.length;
  let loadMore;

  function setOverflowVisible(showAll) {
    for (const [index, item] of items.entries()) {
      item.hidden = !showAll && index >= previewSessionLimit;
    }
    if (loadMore) loadMore.hidden = !showAll;
  }

  if (page?.nextCursor) {
    loadMore = documentRoot.createElement("button");
    loadMore.type = "button";
    loadMore.className = "project-session-load-more project-session-more";
    loadMore.disabled = Boolean(page.pending);
    loadMore.setAttribute("aria-controls", rows.id);
    loadMore.textContent = `Load more (${Math.max(0, total - items.length)})`;
    if (page.errorMessage) loadMore.textContent = "Could not load conversations — retry";
    if (page.pending) loadMore.textContent = "Loading conversations…";
    loadMore.setAttribute("aria-label", `${loadMore.textContent} in ${group.name}`);
    loadMore.addEventListener("click", () => void onLoadMore());
  }

  setOverflowVisible(expanded || searching);
  if (!canExpandProjectSessions(total, query)) {
    if (loadMore) content.appendChild(loadMore);
    return;
  }
  const toggle = documentRoot.createElement("button");
  toggle.type = "button";
  toggle.className = "project-session-more";
  toggle.setAttribute("aria-controls", rows.id);

  function updateToggle() {
    toggle.textContent = expanded
      ? "Show less"
      : `Show more (${Math.max(0, total - previewSessionLimit)})`;
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-label", `${toggle.textContent} conversations in ${group.name}`);
  }

  updateToggle();
  toggle.addEventListener("click", () => {
    expanded = !expanded;
    setOverflowVisible(expanded);
    updateToggle();
    onToggleExpanded(group.id, expanded);
    if (expanded && needsFirstProjectExpansionPage(items, page)) void onLoadMore();
  });
  content.appendChild(toggle);
  if (loadMore) content.appendChild(loadMore);
}
