function confirmedResetIds(result) {
  return new Set([...result.deletedSessionIds, ...result.clearedSessionIds]);
}

/** Reconcile only acknowledged targets; unsaved text and other environments survive. */
export async function reconcileRuntimeSessionReset({
  result, environmentId, getEnvironmentId, state, preferences, clearSessionDraft, refreshComposer,
  clearCurrentSession, preserveSessionDraft, restoreSessionDraft, loadSessions, refreshDashboard, forgetDeletedSessionPins,
}) {
  const deleted = new Set(result.deletedSessionIds);
  const affected = confirmedResetIds(result);
  const current = environmentId === getEnvironmentId();
  const selected = preferences.sessionIdForEnvironment(environmentId);
  const selectedDraft = current ? state.currentSessionId : selected;
  const restoredId = deleted.has(selectedDraft)
    ? preserveSessionDraft({ environmentId, sessionId: selectedDraft }) : undefined;
  for (const sessionId of affected) clearSessionDraft({ environmentId, sessionId }, deleted.has(sessionId));
  const writes = [];
  if (deleted.has(selected) || (current && restoredId !== undefined))
    writes.push(preferences.saveSessionIdForEnvironment(environmentId, restoredId ?? ""));
  if (!current) { await Promise.all(writes); return; }
  for (const sessionId of deleted) {
    delete state.sessionModels[sessionId];
    delete state.sessionModes[sessionId];
  }
  state.sessions = state.sessions.filter((session) => !deleted.has(session.id));
  if (deleted.has(state.currentSessionId)) {
    clearCurrentSession();
    if (restoredId !== undefined) restoreSessionDraft(restoredId);
  }
  refreshComposer();
  const sidebar = preferences.loadSessionSidebar(environmentId);
  writes.push(
    forgetDeletedSessionPins([...deleted]),
    preferences.saveSessionModes(state.sessionModes),
    preferences.saveModelPreferences(state.sessionModels, state.lastModelByEnvironment),
    preferences.saveSessionSidebar(environmentId, {
      archivedSessionIds: sidebar.archivedSessionIds.filter((id) => !deleted.has(id)),
      orderedSessionIds: sidebar.orderedSessionIds.filter((id) => !deleted.has(id)),
    }),
  );
  const outcomes = await Promise.allSettled([...writes, loadSessions(), refreshDashboard()]);
  if (outcomes.some((outcome) => outcome.status === "rejected")) throw new Error("runtime_reset_view_refresh_failed");
}
