import { escapeHtml, escapeAttribute } from "../lib/text-format.js";
import { matchesSessionQuery } from "../ui-behavior.js";

export function renderProjectSessionGroups({
  root,
  projects,
  sessions,
  createSessionItem,
  query,
  loading,
  error,
  busyProjectId,
  onNewConversation,
  onRetry,
  documentRoot = document,
}) {
  const groups = new Map(
    projects.map((project) => [project.id, { ...project, sessions: [] }]),
  );
  const ordinary = [];
  for (const session of sessions) {
    const projectId = session.projectId || session.project?.id;
    if (!projectId) {
      ordinary.push(session);
      continue;
    }
    const group = groups.get(projectId) ?? {
      id: projectId,
      name: session.project?.name || "Project",
      directory: session.project?.directory || "",
      sessions: [],
    };
    group.sessions.push(session);
    groups.set(projectId, group);
  }
  let index = 0;
  const heading = documentRoot.createElement("div");
  heading.className = "project-section-heading";
  heading.textContent = "Projects";
  root.appendChild(heading);
  for (const group of groups.values()) {
    const matchesProject = matchesSessionQuery(
      [group.name, group.directory],
      query,
    );
    if (!matchesProject && group.sessions.length === 0) continue;
    const section = documentRoot.createElement("section");
    section.className = "project-session-group";
    section.innerHTML = `<header title="${escapeAttribute(group.directory)}"><span class="project-group-title" dir="auto">${escapeHtml(group.name)}</span><button type="button" title="New conversation in ${escapeAttribute(group.name)}" aria-label="New conversation in ${escapeAttribute(group.name)}" ${busyProjectId ? "disabled" : ""}>${busyProjectId === group.id ? "…" : "+"}</button></header>`;
    section
      .querySelector("button")
      .addEventListener("click", () => void onNewConversation(group.id));
    for (const session of group.sessions)
      section.appendChild(createSessionItem(session, index++));
    if (group.sessions.length === 0) {
      const empty = documentRoot.createElement("p");
      empty.className = "project-empty-copy";
      empty.textContent = query
        ? "No matching conversations"
        : "No conversations yet";
      section.appendChild(empty);
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
  regularHeading.textContent = "Conversations";
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
