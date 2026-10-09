import { mergeHistoryPage } from "../lib/history-page-messages.js";

export function canRestoreSnapshotQueue(snapshot, waitingRequestId) {
  if (!snapshot) return false;
  if (!waitingRequestId) return true;
  return (snapshot.requests || []).some((request) => request.requestId === waitingRequestId);
}

export function createHistoryPagination({ state, dom, client, selectedEnvironmentId, normalizeMessage, onRequests, renderMessages, conversationView, applyReadState, loadLatest, onNewerPage = () => {} }) {
  let revision = 0;
  let pending = false;
  let older = null;
  let newer = null;
  let error = "";
  let scrollRequested = false;
  let windowEnd;
  const requestIds = new Set();
  function reset() {
    revision += 1; pending = false; older = null; newer = null; error = ""; requestIds.clear();
    scrollRequested = false;
    windowEnd = undefined;
  }
  function adopt(snapshot) {
    scrollRequested = false;
    older = snapshot.nextCursor || null; newer = snapshot.newerCursor || null;
    windowEnd = snapshot.messages?.length ? normalizeMessage(snapshot.messages.at(-1)) : undefined;
    for (const request of snapshot.requests || []) requestIds.add(request.requestId);
  }
  function refresh(snapshot) {
    if (newer) return;
    const first = snapshot.messages?.[0];
    if (!first) { adopt(snapshot); return; }
    const overlaps = state.messages.some((message) => String(message.persistedMessageId ?? message.id) === String(first.id) && message.createdAt === first.createdAt);
    if (!overlaps) { reset(); adopt(snapshot); }
  }
  function isCurrent(environmentId, sessionId, version, viewVersion) {
    if (version !== revision || viewVersion !== state.sessionViewVersion) return false;
    if (environmentId !== selectedEnvironmentId()) return false;
    return sessionId === state.currentSessionId;
  }
  async function load(direction = "older") {
    const cursor = direction === "older" ? older : newer;
    if (pending || !cursor) return;
    scrollRequested = false;
    const environmentId = selectedEnvironmentId();
    const sessionId = state.currentSessionId;
    const version = revision;
    const viewVersion = state.sessionViewVersion;
    pending = true; error = "";
    if (conversationView.preserveScroll) conversationView.preserveScroll(renderMessages);
    else renderMessages();
    try {
      const snapshot = await client.loadSession(sessionId, environmentId, { cursor });
      if (!isCurrent(environmentId, sessionId, version, viewVersion)) return;
      const incoming = (snapshot.messages || []).map(normalizeMessage);
      const requests = (snapshot.requests || []).filter((request) => !requestIds.has(request.requestId));
      for (const request of requests) requestIds.add(request.requestId);
      const merge = () => {
        mergeHistoryPage(state, incoming, direction, windowEnd);
        if (direction === "newer" && incoming.length) windowEnd = incoming.at(-1);
        if (direction === "older") older = snapshot.nextCursor || null;
        else newer = snapshot.newerCursor || null;
        onRequests(requests);
        applyReadState(sessionId, snapshot.readState);
        pending = false;
        renderMessages();
      };
      if (conversationView.preserveScroll) conversationView.preserveScroll(merge);
      else merge();
      if (direction === "newer" && incoming.length) onNewerPage(incoming);
    } catch (failure) {
      if (!isCurrent(environmentId, sessionId, version, viewVersion)) return;
      error = failure.code === "history_cursor_stale" ? "History changed. Reopen this conversation." : "Could not load history. Retry.";
      if (failure.code === "history_cursor_stale") { older = null; newer = null; }
    } finally {
      if (isCurrent(environmentId, sessionId, version, viewVersion)) { pending = false; renderMessages(); }
    }
  }
  function renderControls(root) {
    if (!root?.ownerDocument) return;
    for (const [direction, cursor, label] of [["older", older, "Load older messages"], ["newer", newer, "Load newer messages"]]) {
      if (!cursor) continue;
      const button = root.ownerDocument.createElement("button");
      button.type = "button"; button.className = "history-page-button";
      button.disabled = pending;
      button.textContent = pending ? "Loading…" : error || label;
      button.addEventListener("click", () => void load(direction));
      if (direction === "older") root.prepend(button);
      else root.append(button);
    }
    if (error && !older && !newer) {
      const note = root.ownerDocument.createElement("p"); note.textContent = error; root.prepend(note);
    }
  }
  // Rendering and target positioning also emit scroll events; only user input can request another page.
  for (const name of ["wheel", "touchmove", "pointerdown"]) {
    dom.messagesList?.addEventListener?.(name, () => { scrollRequested = true; }, { passive: true });
  }
  dom.messagesList?.addEventListener?.("keydown", (event) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) scrollRequested = true;
  });
  dom.messagesList?.addEventListener?.("scroll", () => {
    if (error || pending || !scrollRequested) return;
    const root = dom.messagesList;
    if (root.scrollTop < 60 && older) { scrollRequested = false; void load("older"); return; }
    if (root.scrollHeight - root.scrollTop - root.clientHeight < 60 && newer) { scrollRequested = false; void load("newer"); }
  }, { passive: true });
  const controller = { reset, adopt, refresh, load, renderControls, latest: loadLatest, hasNewer: () => Boolean(newer) };
  conversationView.setHistoryPager?.(controller);
  return controller;
}
