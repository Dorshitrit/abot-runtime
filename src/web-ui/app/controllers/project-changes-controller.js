function projectScopeKey(scope) {
  if (!scope?.environmentId || !scope?.sessionId) return "";
  return JSON.stringify([scope.environmentId, scope.sessionId]);
}
function emptyState() {
  return { anchorId: "", open: false, loading: false, changes: null, error: "", selectedId: "", file: null, fileLoading: false, fileError: "", opener: null, restoreFocus: false };
}

/** Current project data only; scope and revisions never attribute edits to an agent. */
export function createProjectChangesController({ client, getScope, render, AbortControllerImpl = globalThis.AbortController }) {
  let state = emptyState();
  let scopeKey = "";
  let boundRequestId = "";
  let summaryVersion = 0;
  let detailVersion = 0;
  let summaryAbort = null;
  let detailAbort = null;

  function cancelDetail() {
    detailVersion += 1;
    detailAbort?.abort();
    detailAbort = null;
  }
  function reset() {
    summaryVersion += 1;
    summaryAbort?.abort();
    summaryAbort = null;
    cancelDetail();
    scopeKey = "";
    boundRequestId = "";
    state = emptyState();
    render(state);
  }
  function matchesBoundRequest(scope) {
    // Terminal rendering can start a read before the same request becomes idle.
    return !scope?.activeRequestId || scope.activeRequestId === boundRequestId;
  }
  function ownsScope(key) {
    const scope = getScope();
    if (scopeKey !== key || projectScopeKey(scope) !== key) return false;
    return matchesBoundRequest(scope);
  }
  function ownsSummary(version, key) {
    if (version !== summaryVersion) return false;
    return ownsScope(key);
  }
  function ownsDetail(version, key, revision, fileId) {
    if (version !== detailVersion || !state.open) return false;
    if (!ownsScope(key)) return false;
    if (state.changes?.revision !== revision) return false;
    return state.selectedId === fileId;
  }
  async function refresh() {
    if (!scopeKey || !state.anchorId) return;
    summaryAbort?.abort();
    cancelDetail();
    const version = ++summaryVersion;
    const key = scopeKey;
    const scope = { ...getScope() };
    summaryAbort = new AbortControllerImpl();
    state = { ...state, loading: true, changes: null, error: "", selectedId: "", file: null, fileLoading: false, fileError: "" };
    render(state);
    try {
      const result = await client.loadProjectChanges({ environmentId: scope.environmentId, sessionId: scope.sessionId, signal: summaryAbort.signal });
      if (!ownsSummary(version, key)) return;
      state = { ...state, loading: false, changes: result.changes };
    } catch {
      if (!ownsSummary(version, key)) return;
      state = { ...state, loading: false, error: "Project changes could not be loaded. Try refreshing." };
    }
    if (ownsSummary(version, key)) render(state);
  }
  function sync({ anchorId = "", isLatestWindow = true } = {}) {
    const scope = getScope();
    const key = projectScopeKey(scope);
    if (!client.supportsProjectChanges() || !key || !anchorId || !isLatestWindow) {
      if (scopeKey || state.anchorId) reset();
      return;
    }
    if (scopeKey === key && state.anchorId === anchorId && matchesBoundRequest(scope)) return;
    reset();
    scopeKey = key;
    boundRequestId = scope.activeRequestId || "";
    state = { ...state, anchorId };
    void refresh();
  }
  function open(opener) {
    if (!state.anchorId || state.loading) return;
    if (!ownsScope(scopeKey)) return;
    state = { ...state, open: true, opener, restoreFocus: false };
    render(state);
  }
  function close({ restoreFocus = true } = {}) {
    cancelDetail();
    state = { ...state, open: false, fileLoading: false, opener: null, restoreFocus };
    render(state);
  }
  async function selectFile(fileId) {
    if (!state.open || state.loading) return;
    const revision = state.changes?.revision;
    if (!revision || !state.changes.files.some((file) => file.id === fileId)) return;
    cancelDetail();
    const version = detailVersion;
    const key = scopeKey;
    const scope = { ...getScope() };
    detailAbort = new AbortControllerImpl();
    state = { ...state, selectedId: fileId, file: null, fileLoading: true, fileError: "" };
    render(state);
    try {
      const result = await client.loadProjectChangeDiff({ environmentId: scope.environmentId, sessionId: scope.sessionId, revision, fileId, signal: detailAbort.signal });
      if (!ownsDetail(version, key, revision, fileId)) return;
      state = { ...state, fileLoading: false, file: result.file };
    } catch (error) {
      if (!ownsDetail(version, key, revision, fileId)) return;
      const fileError = error?.code === "project_changes_stale"
        ? "The project changed. Refresh the file list to view current changes."
        : "This diff could not be loaded. Refresh and try again.";
      state = { ...state, fileLoading: false, fileError };
    }
    if (ownsDetail(version, key, revision, fileId)) render(state);
  }
  return { sync, open, close, refresh, selectFile, reset };
}
