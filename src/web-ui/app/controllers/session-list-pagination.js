import { mergeSessionListReadState } from "../lib/session-read-state.js";
import { sessionProjectId } from "../lib/session-project-groups.js";

export function createSessionListPagination({ state, dom, client, sessions, selectedEnvironmentId, renderSessions, onSessionListState }) {
  let revision = 0;
  let pageRequest = 0;
  let pending = false;
  let refreshing = false;
  let ordinaryResetRequired = false;
  let nextCursor = null;
  let pageInfo = {};
  let projectPages = new Map();
  let queryKey = "";
  let errorMessage = "";
  const query = () => ({ ...sessions.paginationQuery?.(), query: state.sessionQuery || "" });

  function invalidate() {
    state.sessionOverview = undefined;
    revision += 1;
    pending = false;
    refreshing = false;
    ordinaryResetRequired = false;
    nextCursor = null;
    pageInfo = {};
    projectPages.clear();
    queryKey = "";
    errorMessage = "";
  }

  function isCurrent(environmentId, version, key) {
    if (version !== revision) return false;
    if (environmentId !== selectedEnvironmentId()) return false;
    return key === JSON.stringify(query());
  }

  function canContinueOrdinaryPage(key) {
    if (pending) return false;
    if (!nextCursor) return false;
    return key === queryKey;
  }

  function mergeSessions(incoming, append, retained = state.sessions) {
    const merged = append ? [...retained, ...incoming] : incoming;
    state.sessions = mergeSessionListReadState(
      [...new Map(merged.map((session) => [session.id, session])).values()], state.sessions,
    );
  }

  function hasOlderProjectDeletionCatalog(payload) {
    if (!Array.isArray(payload.deletedProjectIds)) return false;
    const deleted = new Set(payload.deletedProjectIds);
    return (pageInfo.deletedProjectIds ?? []).some((id) => !deleted.has(id));
  }

  function hasNewProjectDeletions(payload) {
    if (!Array.isArray(pageInfo.deletedProjectIds)) return false;
    const known = new Set(pageInfo.deletedProjectIds);
    return (payload.deletedProjectIds ?? []).some((id) => !known.has(id));
  }

  function receivePageMetadata(payload) {
    if (hasOlderProjectDeletionCatalog(payload)) return false;
    const ordinaryScopeChanged = hasNewProjectDeletions(payload);
    pageInfo = { ...pageInfo, total: payload.total, archivedCount: payload.archivedCount };
    for (const field of ["ordinaryTotal", "projects", "deletedProjectIds"]) {
      if (payload[field] !== undefined) pageInfo[field] = payload[field];
    }
    return ordinaryScopeChanged;
  }

  function belongsToOrdinaryPage(session, input) {
    if (input.archived !== true && input.pinnedSessionIds?.includes(session.id)) return false;
    return !sessionProjectId(session, pageInfo.deletedProjectIds ?? []);
  }

  function receivePage(payload, more, ordinaryOnly, input) {
    const incoming = Array.isArray(payload.sessions) ? payload.sessions : [];
    if (ordinaryOnly) {
      const retained = state.sessions.filter((session) => !belongsToOrdinaryPage(session, input));
      mergeSessions(incoming, true, retained);
    } else {
      mergeSessions(incoming, more);
    }
    nextCursor = payload.nextCursor || null;
    ordinaryResetRequired = false;
    if (!more && !ordinaryOnly) {
      projectPages = new Map((payload.projectPages ?? []).map((page) =>
        [page.projectId, { ...page, pending: false, errorMessage: "" }],
      ));
    }
    if (payload.overview) state.sessionOverview = payload.overview;
  }

  async function load(more = false, ordinaryOnly = false) {
    const input = query();
    const key = JSON.stringify(input);
    if (more && !canContinueOrdinaryPage(key)) return state.sessions;
    if (!more && !ordinaryOnly) {
      revision += 1;
      ordinaryResetRequired = false;
      nextCursor = null;
      projectPages.clear();
      pageInfo = {};
      refreshing = true;
    }
    if (ordinaryOnly) {
      ordinaryResetRequired = true;
      nextCursor = null;
    }
    const environmentId = selectedEnvironmentId();
    const version = revision;
    const request = ++pageRequest;
    const cursor = more ? nextCursor : null;
    const scope = (more || ordinaryOnly) && input.sidebar ? { scope: { kind: "ordinary" } } : {};
    pending = true;
    errorMessage = "";
    queryKey = key;
    onSessionListState({ status: "loading", sessions: state.sessions });
    renderSessions();
    try {
      const payload = await client.listSessions(environmentId, { ...input, ...scope, cursor });
      if (!isCurrent(environmentId, version, key)) return [];
      if (request !== pageRequest) return [];
      const ordinaryScopeChanged = receivePageMetadata(payload);
      if (ordinaryScopeChanged && more) return await load(false, true);
      receivePage(payload, more, ordinaryOnly, input);
      onSessionListState({ status: "ready", sessions: state.sessions });
      return state.sessions;
    } catch (error) {
      if (!isCurrent(environmentId, version, key)) return [];
      if (request !== pageRequest) return [];
      errorMessage = error instanceof Error ? error.message : String(error);
      onSessionListState({ status: "error", sessions: state.sessions, error: errorMessage });
      return [];
    } finally {
      if (version === revision && request === pageRequest) {
        pending = false;
        refreshing = false;
        renderSessions();
      }
    }
  }

  function canContinueProjectPage(page, key) {
    if (refreshing) return false;
    if (!page?.nextCursor) return false;
    if (page.pending) return false;
    return key === queryKey;
  }

  async function loadProject(projectId) {
    const input = query();
    const key = JSON.stringify(input);
    const page = projectPages.get(projectId);
    if (!canContinueProjectPage(page, key)) return state.sessions;
    const environmentId = selectedEnvironmentId();
    const version = revision;
    page.pending = true;
    page.errorMessage = "";
    renderSessions();
    try {
      const payload = await client.listSessions(environmentId, {
        ...input, scope: { kind: "project", projectId }, cursor: page.nextCursor,
      });
      if (!isCurrent(environmentId, version, key)) return [];
      const received = payload.projectPages?.find((entry) => entry.projectId === projectId);
      if (!received) throw new Error("Project conversation page is unavailable.");
      const ordinaryScopeChanged = receivePageMetadata(payload);
      const incoming = Array.isArray(payload.sessions) ? payload.sessions : [];
      mergeSessions(incoming.filter((session) => sessionProjectId(session, pageInfo.deletedProjectIds ?? []) === projectId), true);
      projectPages.set(projectId, { ...received, pending: false, errorMessage: "" });
      if (ordinaryScopeChanged) return await load(false, true);
      onSessionListState({ status: "ready", sessions: state.sessions });
      return state.sessions;
    } catch (error) {
      if (!isCurrent(environmentId, version, key)) return [];
      page.errorMessage = error instanceof Error ? error.message : String(error);
      return [];
    } finally {
      if (isCurrent(environmentId, version, key)) {
        page.pending = false;
        renderSessions();
      }
    }
  }

  function loadOrdinaryFooterPage() {
    if (ordinaryResetRequired) return load(false, true);
    return load(Boolean(nextCursor));
  }

  function renderFooter() {
    const root = dom.sessionsList;
    if (!root?.ownerDocument) return;
    if (!pending && !nextCursor && !errorMessage) return;
    const button = root.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "session-archive-toggle";
    button.disabled = pending;
    button.textContent = pending ? "Loading conversations…" : errorMessage ? "Could not load conversations — retry" : "Load more conversations";
    button.addEventListener("click", () => void loadOrdinaryFooterPage());
    root.appendChild(button);
  }
  dom.sessionsList?.addEventListener?.("scroll", () => {
    const root = dom.sessionsList;
    if (root.scrollHeight - root.scrollTop - root.clientHeight > 100) return;
    if (!errorMessage) void load(true);
  }, { passive: true });
  const controller = { load, loadProject, invalidate, renderFooter,
    info: () => ({ ...pageInfo, projectPages: [...projectPages.values()] }) };
  sessions.setPagination?.(controller);
  return controller;
}
