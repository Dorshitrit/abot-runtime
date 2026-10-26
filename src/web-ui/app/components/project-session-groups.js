import { projectSessionDisplayGroups } from "../lib/session-project-groups.js";
import { escapeHtml } from "../lib/text-format.js";
import { matchesSessionQuery } from "../ui-behavior.js";
import { renderProjectSessionPreview } from "./project-session-preview.js";
import { createProjectGroupActions } from "./project-group-actions.js";

function shouldExpandProjectGroup(projectId, query, collapsedProjectIds) {
  if (String(query ?? "").trim()) return true;
  return !collapsedProjectIds.has(projectId);
}

function createProjectGroup({
  group, query, collapsedProjectIds, busyProjectId,
  onToggleGroup, onNewConversation, onDeleteProject, documentRoot,
}) {
  const section = documentRoot.createElement("section");
  section.className = "project-session-group";
  const header = documentRoot.createElement("header");
  header.title = group.directory;
  const content = documentRoot.createElement("div");
  content.className = "project-group-content";
  content.id = "project-sessions-" + encodeURIComponent(group.id);
  content.hidden = !shouldExpandProjectGroup(group.id, query, collapsedProjectIds);
  const toggle = documentRoot.createElement("button");
  toggle.type = "button";
  toggle.className = "project-group-toggle";
  toggle.setAttribute("aria-expanded", String(!content.hidden));
  toggle.setAttribute("aria-controls", content.id);
  const title = documentRoot.createElement("span");
  title.className = "project-group-title";
  title.dir = "auto";
  title.textContent = group.name;
  toggle.appendChild(title);
  toggle.addEventListener("click", () => {
    content.hidden = !content.hidden;
    toggle.setAttribute("aria-expanded", String(!content.hidden));
    onToggleGroup(group.id, content.hidden);
  });
  header.appendChild(toggle);
  const create = documentRoot.createElement("button");
  create.type = "button";
  create.className = "project-group-new";
  create.title = "New conversation in " + group.name;
  create.setAttribute("aria-label", create.title);
  create.disabled = Boolean(busyProjectId);
  create.innerHTML = busyProjectId === group.id ? "…"
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  create.addEventListener("click", () => void onNewConversation(group.id));
  const controls = documentRoot.createElement("div");
  controls.className = "project-group-controls";
  controls.append(create, createProjectGroupActions({
    group, disabled: Boolean(busyProjectId), onDeleteProject, documentRoot,
  }));
  header.appendChild(controls);
  section.append(header, content);
  return { section, content };
}

export function renderProjectSessionGroups({
  root,
  projects,
  deletedProjectIds = [],
  sessions,
  createSessionItem,
  pageInfo,
  onLoadProject,
  newProjectButton,
  query,
  loading,
  error,
  busyProjectId,
  onNewConversation,
  onDeleteProject = () => {},
  onRetry,
  collapsedProjectIds = new Set(),
  expandedProjectSessionIds = new Set(),
  onToggleGroup = () => {},
  onToggleProjectSessions = () => {},
  documentRoot = document,
}) {
  const catalog = [...new Map([...(pageInfo?.projects ?? []), ...projects].map((project) => [project.id, project])).values()];
  const deleted = [...new Set([...(pageInfo?.deletedProjectIds ?? []), ...deletedProjectIds])];
  const { groups, ordinary } = projectSessionDisplayGroups(catalog, sessions, deleted);
  let index = 0;
  if (newProjectButton) root.appendChild(newProjectButton);
  for (const group of groups) {
    const matchesProject = matchesSessionQuery(
      [group.name, group.directory],
      query,
    );
    if (!matchesProject && group.sessions.length === 0) continue;
    const { section, content } = createProjectGroup({
      group, query, collapsedProjectIds, busyProjectId,
      onToggleGroup, onNewConversation, onDeleteProject, documentRoot,
    });
    renderProjectSessionPreview({
      content, group, query, documentRoot,
      page: pageInfo?.projectPages?.find((page) => page.projectId === group.id),
      onLoadMore: () => onLoadProject?.(group.id),
      expanded: expandedProjectSessionIds.has(group.id),
      createSessionItem: (session) => createSessionItem(session, index++),
      onToggleExpanded: onToggleProjectSessions,
    });
    if (group.sessions.length === 0) {
      const empty = documentRoot.createElement("p");
      empty.className = "project-empty-copy";
      empty.textContent = query
        ? "No matching conversations"
        : "No conversations yet";
      content.appendChild(empty);
    }
    root.appendChild(section);
  }
  if (loading) {
    const status = documentRoot.createElement("p");
    status.className = "project-empty-copy";
    status.textContent = "Loading projects…";
    status.setAttribute("role", "status");
    root.appendChild(status);
  }
  if (error) {
    const status = documentRoot.createElement("div");
    status.className = "project-load-error";
    status.setAttribute("role", "alert");
    status.innerHTML = `<span>${escapeHtml(error)}</span><button type="button">Retry</button>`;
    status.querySelector("button").addEventListener("click", onRetry);
    root.appendChild(status);
  }
  const regularHeading = documentRoot.createElement("div");
  regularHeading.className =
    "project-section-heading ordinary-conversations-heading";
  regularHeading.textContent = pageInfo?.ordinaryTotal === undefined
    ? "Conversations" : `Conversations (${pageInfo.ordinaryTotal})`;
  root.appendChild(regularHeading);
  for (const session of ordinary)
    root.appendChild(createSessionItem(session, index++));
  if (ordinary.length === 0) {
    const empty = documentRoot.createElement("p");
    empty.className = "project-empty-copy";
    empty.textContent = query
      ? "No matching conversations"
      : "No ordinary conversations yet";
    root.appendChild(empty);
  }
}
