export function sessionProjectId(session, deletedProjectIds = []) {
  const projectId = session.projectId || session.project?.id;
  if (deletedProjectIds.includes(projectId)) return undefined;
  return projectId;
}

/** Group by actual project identity without changing session workspace bindings. */
export function projectSessionDisplayGroups(projects, sessions, deletedProjectIds = []) {
  const deletedProjects = new Set(deletedProjectIds);
  const groups = new Map(projects.filter((project) => !deletedProjects.has(project.id))
    .map((project) => [project.id, { ...project, sessions: [] }]));
  const ordinary = [];
  for (const session of sessions) {
    const projectId = sessionProjectId(session);
    const isOrdinarySession = !projectId || deletedProjects.has(projectId);
    if (isOrdinarySession) {
      ordinary.push(session);
      continue;
    }
    const group = groups.get(projectId) ?? {
      id: projectId, name: session.project?.name || "Project",
      directory: session.project?.directory || "", sessions: [],
    };
    group.sessions.push(session);
    groups.set(projectId, group);
  }
  return { groups: [...groups.values()], ordinary };
}
