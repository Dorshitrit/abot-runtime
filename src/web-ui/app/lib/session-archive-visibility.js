export function filterSessionsByArchiveState(sessions, archivedSessionIds = [], archivedOnly = false) {
  const archived = new Set(archivedSessionIds);
  return sessions.filter((session) => archived.has(session.id) === archivedOnly);
}
