export function sessionSidebarGroup(session, pinnedSessionIds) {
  if (pinnedSessionIds.includes(session.id)) return "pinned";
  const projectId = session.projectId || session.project?.id;
  if (projectId) return `project:${projectId}`;
  return "ordinary";
}

export function canReorderSidebarSessions(source, target, pinnedSessionIds) {
  if (!source || !target) return false;
  if (source.id === target.id) return false;
  return sessionSidebarGroup(source, pinnedSessionIds) ===
    sessionSidebarGroup(target, pinnedSessionIds);
}

export function orderSidebarSessions(sessions, pinnedSessionIds, orderedSessionIds) {
  const pinnedOrder = new Map(pinnedSessionIds.map((id, index) => [id, index]));
  const manualOrder = new Map(orderedSessionIds.map((id, index) => [id, index]));
  return [...sessions].sort((left, right) => {
    const leftPinned = pinnedOrder.has(left.id);
    const rightPinned = pinnedOrder.has(right.id);
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    if (leftPinned) return pinnedOrder.get(left.id) - pinnedOrder.get(right.id);
    return (manualOrder.get(left.id) ?? -1) - (manualOrder.get(right.id) ?? -1);
  });
}

export function moveSidebarSession(sessionIds, sourceId, targetId, placement) {
  if (sourceId === targetId) return sessionIds;
  if (!sessionIds.includes(sourceId)) return sessionIds;
  if (!sessionIds.includes(targetId)) return sessionIds;
  const next = sessionIds.filter((id) => id !== sourceId);
  const offset = placement === "after" ? 1 : 0;
  next.splice(next.indexOf(targetId) + offset, 0, sourceId);
  return next;
}
