import {
  canReorderSidebarSessions, moveSidebarSession, orderSidebarSessions, sessionSidebarGroup,
} from "../lib/session-sidebar-order.js";
import { createSessionSidebarDrag } from "../components/session-sidebar-drag.js";
import { renderSessionSidebarSections } from "../components/session-sidebar-sections.js";
import { filterSessionsByArchiveState } from "../lib/session-archive-visibility.js";

export function createSessionSidebarController({
  state, preferences, selectedEnvironmentId = () => "", render, showToast, getFilteredSessions,
}) {
  let showingArchived = false;
  let environmentId = selectedEnvironmentId();
  let sidebarRoot = null;

  function savedPreferences() {
    const selected = selectedEnvironmentId();
    if (environmentId !== selected) showingArchived = false;
    environmentId = selected;
    return preferences?.loadSessionSidebar?.(environmentId) ?? {
      archivedSessionIds: [], orderedSessionIds: [],
    };
  }

  function orderedSessions() {
    return orderSidebarSessions(
      state.sessions, state.pinnedSessionIds, savedPreferences().orderedSessionIds,
    );
  }

  function visibleSessions() {
    const saved = savedPreferences();
    return filterSessionsByArchiveState(orderedSessions(), saved.archivedSessionIds, showingArchived);
  }

  function canMoveSidebarSession(sourceId, targetId) {
    if (showingArchived) return false;
    const sessions = visibleSessions();
    return canReorderSidebarSessions(
      sessions.find((session) => session.id === sourceId),
      sessions.find((session) => session.id === targetId),
      state.pinnedSessionIds,
    );
  }

  function saveSidebar(value) {
    try {
      preferences.saveSessionSidebar(environmentId, value);
      return true;
    } catch {
      showToast?.("Could not save conversation preferences in this browser", "failed");
      return false;
    }
  }

  function move(sourceId, targetId, placement) {
    if (!canMoveSidebarSession(sourceId, targetId)) return;
    if (state.pinnedSessionIds.includes(sourceId)) {
      const pinned = moveSidebarSession(state.pinnedSessionIds, sourceId, targetId, placement);
      try {
        preferences.savePinnedSessions(pinned);
      } catch {
        showToast?.("Could not save pinned conversation order", "failed");
        return;
      }
      state.pinnedSessionIds = pinned;
      render();
      return;
    }
    const saved = savedPreferences();
    saved.orderedSessionIds = moveSidebarSession(
      orderedSessions().map((session) => session.id), sourceId, targetId, placement,
    );
    if (saveSidebar(saved)) render();
  }

  function moveInDirection(session, direction) {
    const group = sessionSidebarGroup(session, state.pinnedSessionIds);
    const siblings = getFilteredSessions().filter(isSessionVisibleInSidebar).filter((candidate) =>
      sessionSidebarGroup(candidate, state.pinnedSessionIds) === group,
    );
    const index = siblings.findIndex((candidate) => candidate.id === session.id);
    if (index < 0) return;
    const target = siblings[index + direction];
    if (!target) return;
    move(session.id, target.id, direction < 0 ? "before" : "after");
    document.getElementById(`session-open-${encodeURIComponent(session.id)}`)?.focus();
  }

  function isSessionVisibleInSidebar(session) {
    const button = document.getElementById(`session-open-${encodeURIComponent(session.id)}`);
    if (!sidebarRoot?.contains(button)) return false;
    for (let node = button; node !== sidebarRoot; node = node.parentElement) {
      if (node.hidden) return false;
    }
    return true;
  }

  function setSessionArchived(sessionId, archived) {
    if (!sessionId) return false;
    const saved = savedPreferences();
    if (saved.archivedSessionIds.includes(sessionId) === archived) return true;
    saved.archivedSessionIds = archived
      ? [...saved.archivedSessionIds, sessionId]
      : saved.archivedSessionIds.filter((id) => id !== sessionId);
    if (!saveSidebar(saved)) return false;
    render();
    sidebarRoot?.querySelector(".session-archive-toggle")?.focus();
    showToast?.(archived ? "Conversation archived in this browser" : "Conversation restored");
    return true;
  }

  function toggleArchive(sessionId) {
    const archived = savedPreferences().archivedSessionIds.includes(sessionId);
    return setSessionArchived(sessionId, !archived);
  }

  function archiveSession(sessionId) {
    return setSessionArchived(sessionId, true);
  }

  const drag = createSessionSidebarDrag({ canMove: canMoveSidebarSession, onMove: move });

  function bindItem(item, session) {
    item.querySelector(".archive-action")?.addEventListener("click", () => toggleArchive(session.id));
    const pinAction = item.querySelector(".pin-action");
    if (pinAction) {
      pinAction.hidden = showingArchived;
      pinAction.disabled = showingArchived;
    }
    for (const [selector, direction] of [[".move-up-action", -1], [".move-down-action", 1]]) {
      const button = item.querySelector(selector);
      if (!button) continue;
      button.hidden = showingArchived;
      button.disabled = showingArchived;
      button.addEventListener("click", () => moveInDirection(session, direction));
    }
    if (!showingArchived) drag.bind(item, session.id);
  }

  function renderSections(options) {
    sidebarRoot = options.root;
    drag.reset();
    const saved = savedPreferences();
    renderSessionSidebarSections({
      ...options,
      archivedCount: filterSessionsByArchiveState(state.sessions, saved.archivedSessionIds, true).length,
      showingArchived,
      onToggleArchived: () => {
        showingArchived = !showingArchived;
        render();
        sidebarRoot.querySelector(".session-archive-toggle")?.focus();
      },
      isPinned: (id) => !showingArchived && state.pinnedSessionIds.includes(id),
      hasConversations: state.sessions.length > 0,
    });
  }

  return { archiveSession, bindItem, renderSections, visibleSessions, isArchiveView: () => showingArchived };
}
