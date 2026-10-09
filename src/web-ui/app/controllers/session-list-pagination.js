import { mergeSessionListReadState } from "../lib/session-read-state.js";

export function createSessionListPagination({ state, dom, client, sessions, selectedEnvironmentId, renderSessions, onSessionListState }) {
  let revision = 0;
  let pending = false;
  let nextCursor = null;
  let pageInfo = {};
  let queryKey = "";
  let errorMessage = "";
  const query = () => ({ ...sessions.paginationQuery?.(), query: state.sessionQuery || "" });
  function invalidate() {
    state.sessionOverview = undefined;
    revision += 1; pending = false; nextCursor = null; pageInfo = {}; queryKey = ""; errorMessage = "";
  }
  function isCurrent(environmentId, version, key) {
    if (version !== revision) return false;
    if (environmentId !== selectedEnvironmentId()) return false;
    return key === JSON.stringify(query());
  }
  async function load(more = false) {
    const input = query();
    const key = JSON.stringify(input);
    if (more && (pending || !nextCursor || key !== queryKey)) return state.sessions;
    if (!more) nextCursor = null;
    const environmentId = selectedEnvironmentId();
    const version = ++revision;
    const cursor = more ? nextCursor : null;
    pending = true; errorMessage = ""; queryKey = key;
    onSessionListState({ status: "loading", sessions: state.sessions });
    renderSessions();
    try {
      const payload = await client.listSessions(environmentId, { ...input, cursor });
      if (!isCurrent(environmentId, version, key)) return [];
      const incoming = Array.isArray(payload.sessions) ? payload.sessions : [];
      const merged = more ? [...state.sessions, ...incoming] : incoming;
      state.sessions = mergeSessionListReadState([...new Map(merged.map((session) => [session.id, session])).values()], state.sessions);
      nextCursor = payload.nextCursor || null;
      pageInfo = { total: payload.total, archivedCount: payload.archivedCount };
      if (payload.overview) state.sessionOverview = payload.overview;
      onSessionListState({ status: "ready", sessions: state.sessions });
      return state.sessions;
    } catch (error) {
      if (!isCurrent(environmentId, version, key)) return [];
      errorMessage = error instanceof Error ? error.message : String(error);
      onSessionListState({ status: "error", sessions: state.sessions, error: errorMessage });
      return [];
    } finally {
      if (version === revision) { pending = false; renderSessions(); }
    }
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
    button.addEventListener("click", () => void load(Boolean(nextCursor)));
    root.appendChild(button);
  }
  dom.sessionsList?.addEventListener?.("scroll", () => {
    const root = dom.sessionsList;
    if (root.scrollHeight - root.scrollTop - root.clientHeight > 100) return;
    if (!errorMessage) void load(true);
  }, { passive: true });
  const controller = { load, invalidate, renderFooter, info: () => pageInfo };
  sessions.setPagination?.(controller);
  return controller;
}
