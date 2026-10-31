import { conversationTitle } from "../lib/conversation-title.js";
import { confirmDialog } from "../components/confirmation-dialog.js";
import { createSessionPinUpdates } from "./session-pin-updates.js";
import {
  isOlderSessionReadState,
  isSessionReadStateUnavailable,
  mergeSessionReadStateUpdate,
} from "../lib/session-read-state.js";
import { matchesSessionQuery } from "../ui-behavior.js";
import { escapeAttribute, escapeHtml, textOf } from "../lib/text-format.js";
import { getNumber } from "../lib/event-presentation.js";
import { createSessionSidebarController } from "./session-sidebar-controller.js";
import { captureSessionListViewport, restoreSessionListViewport } from "../components/session-list-viewport.js";

export function createSessionController({
  state,
  dom,
  sessionActionsMenu,
  renderGroups = () => false,
  getDeletedProjectIds = () => [],
  shell,
  preferences,
  client,
  selectedEnvironmentId,
  onOpen,
  onClearCurrent,
  onSessionAttachmentsCleared = () => {},
  onClearSessionMode,
  onSaveModelPreferences,
  onReload,
  onControlEvent,
  onSidebarChange,
  confirmAction = confirmDialog,
  copyText = (value) => navigator.clipboard.writeText(value),
}) {
  let pagination;
  const updatePinnedSessions = createSessionPinUpdates({ state, preferences });
  const titleOf = conversationTitle;
  const byId = (sessionId) =>
    state.sessions.find((session) => textOf(session.id) === sessionId);
  const isPinned = (sessionId) => state.pinnedSessionIds.includes(sessionId);
  const sidebar = createSessionSidebarController({
    state, preferences, updatePinnedSessions, selectedEnvironmentId, showToast: shell?.showToast,
    render: () => { (onSidebarChange ?? render)(); void pagination?.load(); }, getFilteredSessions: filtered,
    getPageInfo: () => pagination?.info(),
    getDeletedProjectIds: () => [...new Set([...getDeletedProjectIds(), ...(pagination?.info().deletedProjectIds ?? [])])],
  });

  function filtered() {
    return sidebar.visibleSessions().filter((session) =>
      matchesSessionQuery(
        [
          titleOf(session),
          textOf(session.lastMessagePreview),
          textOf(session.id),
        ],
        state.sessionQuery,
      ),
    );
  }

  function render() {
    const viewportScope = JSON.stringify([selectedEnvironmentId(), state.sessionQuery, sidebar.isArchiveView()]);
    captureSessionListViewport(dom.sessionsList, viewportScope);
    sessionActionsMenu.reset();
    dom.sessionsList.innerHTML = "";
    const sessions = filtered();
    sidebar.renderSections({ root: dom.sessionsList, sessions, createSessionItem,
      renderGroups: (options) => renderGroups({ ...options, pageInfo: pagination?.info(), onLoadProject: pagination?.loadProject }),
    });
    pagination?.renderFooter();
    restoreSessionListViewport(dom.sessionsList);
  }

  function createSessionItem(session, sessionIndex) {
    const sessionId = textOf(session.id);
    const pinned = isPinned(sessionId);
    const busy = state.busySessionIds.has(sessionId);
    const unreadCount = getNumber(session.unreadCount, 0);
    const unreadLabel = `${unreadCount || 1} unread message${unreadCount > 1 ? "s" : ""}`;
    const unreadUnavailable = isSessionReadStateUnavailable(session);
    const hasUnread = unreadUnavailable
      ? false
      : session.hasUnread === true || unreadCount > 0;
    const item = document.createElement("div");
    item.className = `session-item ${
      session.id === state.currentSessionId ? "active" : ""
    } ${pinned ? "pinned" : ""} ${busy ? "busy" : ""} ${
      hasUnread ? "unread" : ""
    }`;
    item.innerHTML = `
      <button id="session-open-${escapeAttribute(encodeURIComponent(sessionId))}" class="session-open-button" type="button" title="${escapeAttribute(titleOf(session))}">
        <div class="session-title-row">
          <div class="session-title" dir="auto">${escapeHtml(titleOf(session))}</div>
          ${unreadUnavailable ? '<span class="session-unread-badge" title="Unread status unavailable" aria-label="Unread status unavailable">?</span>' : ""}
          ${
            hasUnread
              ? `<span class="session-unread-dot" role="img" title="${escapeAttribute(unreadLabel)}" aria-label="${escapeAttribute(unreadLabel)}"></span>`
              : ""
          }
        </div>
      </button>
      <div class="session-actions" aria-label="Session actions">
        <button class="session-menu-button" type="button" title="Session actions" aria-label="Session actions" aria-haspopup="menu" aria-expanded="false" aria-controls="session-menu-${sessionIndex}">•••</button>
        <div id="session-menu-${sessionIndex}" class="session-menu" role="menu" hidden>
          <button class="session-action pin-action" type="button" role="menuitem" tabindex="-1" title="${pinned ? "Unpin session" : "Pin session"}">${pinned ? "Unpin" : "Pin"}</button>
          <button class="session-action move-up-action" type="button" role="menuitem" tabindex="-1">Move up</button>
          <button class="session-action move-down-action" type="button" role="menuitem" tabindex="-1">Move down</button>
          <button class="session-action archive-action" type="button" role="menuitem" tabindex="-1" title="Hide or restore this conversation in this ABot installation and environment">${sidebar.isArchiveView() ? "Restore" : "Archive"}</button>
          <button class="session-action copy-filename-action" type="button" role="menuitem" tabindex="-1" title="Copy session filename">Copy filename</button>
          <button class="session-action clear-action" type="button" role="menuitem" tabindex="-1" title="Reset messages">Reset</button>
          <button class="session-action delete-action" type="button" role="menuitem" tabindex="-1" title="Delete session">Delete</button>
        </div>
      </div>
    `;
    item
      .querySelector(".session-open-button")
      ?.addEventListener("click", () => {
        shell.setSessionsDrawerOpen(false);
        void onOpen(session.id);
      });
    item
      .querySelector(".pin-action")
      ?.addEventListener("click", () => togglePinned(sessionId));
    item
      .querySelector(".copy-filename-action")
      ?.addEventListener("click", () => void copyFilename(sessionId));
    item
      .querySelector(".clear-action")
      ?.addEventListener("click", () => void clearMessages(sessionId));
    item
      .querySelector(".delete-action")
      ?.addEventListener("click", () => void deleteSession(sessionId));
    sidebar.bindItem(item, session);
    return item;
  }

  function setCurrentTitle(title) {
    if (state.currentSessionId) {
      dom.sessionTitle.textContent = conversationTitle({ ...byId(state.currentSessionId), id: state.currentSessionId, title });
    }
  }

  function applyTitle(sessionId, title) {
    const normalizedSessionId = textOf(sessionId);
    const normalizedTitle = textOf(title).trim();
    if (!normalizedSessionId || !normalizedTitle) return false;
    let found = false;
    let changed = false;
    state.sessions = state.sessions.map((session) => {
      if (textOf(session.id) !== normalizedSessionId) return session;
      found = true;
      if (session.title === normalizedTitle) return session;
      changed = true;
      return {
        ...session,
        title: normalizedTitle,
        updatedAt: session.updatedAt || Date.now(),
      };
    });
    if (!found && state.currentSessionId === normalizedSessionId) {
      state.sessions = [
        {
          id: normalizedSessionId,
          title: normalizedTitle,
          updatedAt: Date.now(),
          lastMessagePreview: "",
        },
        ...state.sessions,
      ];
      changed = true;
    }
    if (state.currentSessionId === normalizedSessionId)
      setCurrentTitle(normalizedTitle);
    if (changed) render();
    return changed;
  }

  function applyReadState(sessionId, readState) {
    const incoming =
      readState && typeof readState === "object" ? readState : {};
    const normalizedSessionId = textOf(incoming.sessionId || sessionId);
    if (!normalizedSessionId) return false;
    const known = byId(normalizedSessionId);
    if (isOlderSessionReadState(incoming, known)) return false;
    const value = mergeSessionReadStateUpdate(incoming, known);
    const unreadUnavailable = isSessionReadStateUnavailable(value);
    const unreadCount = getNumber(value.unreadCount, 0);
    const normalized = {
      sessionId: normalizedSessionId,
      readStateStatus: unreadUnavailable
        ? "unavailable"
        : value.readStateStatus,
      lastReadMessageId: textOf(value.lastReadMessageId),
      lastReadAt: value.lastReadAt || null,
      unreadCount,
      hasUnread: value.hasUnread === true || unreadCount > 0,
      latestMessageId: textOf(value.latestMessageId),
      latestAssistantMessageId: textOf(value.latestAssistantMessageId),
    };
    if (unreadUnavailable) {
      for (const field of [
        "lastReadMessageId",
        "lastReadAt",
        "unreadCount",
        "hasUnread",
      ])
        normalized[field] = value[field] ?? null;
    }
    let changed = false;
    state.sessions = state.sessions.map((session) => {
      if (textOf(session.id) !== normalized.sessionId) return session;
      changed = true;
      return {
        ...session,
        readState: normalized,
        readStateStatus: normalized.readStateStatus,
        unreadCount: normalized.unreadCount,
        hasUnread: normalized.hasUnread,
        lastReadMessageId: normalized.lastReadMessageId,
        lastReadAt: normalized.lastReadAt,
        latestMessageId: normalized.latestMessageId || session.latestMessageId,
        latestAssistantMessageId:
          normalized.latestAssistantMessageId ||
          session.latestAssistantMessageId,
      };
    });
    if (changed) (onSidebarChange ?? render)();
    return changed;
  }

  function setBusy(sessionId, busy) {
    if (busy) state.busySessionIds.add(sessionId);
    else state.busySessionIds.delete(sessionId);
    render();
  }

  async function togglePinned(sessionId) {
    if (!sessionId) return;
    try {
      await updatePinnedSessions((pins) => pins.includes(sessionId)
        ? pins.filter((item) => item !== sessionId) : [sessionId, ...pins]);
    }
    catch { shell.showToast("Could not save pinned conversations", "failed"); return; }
    render();
    void pagination?.load();
  }

  async function copyFilename(sessionId) {
    sessionActionsMenu.close({ restoreFocus: true });
    try {
      await copyText(`${sessionId}.json`);
      shell.showToast("Session filename copied");
    } catch {
      shell.showToast("Could not copy session filename", "failed");
    }
  }

  function captureSessionMutationTarget(sessionId) {
    const session = byId(sessionId);
    return { environmentId: selectedEnvironmentId(), sessionId,
      currentSessionId: state.currentSessionId, viewVersion: state.sessionViewVersion,
      recordRevision: JSON.stringify([Boolean(session), session?.title, session?.updatedAt, session?.latestMessageId]) };
  }

  function isCurrentSessionMutationTarget(target) {
    if (selectedEnvironmentId() !== target.environmentId) return false;
    if (state.currentSessionId !== target.currentSessionId) return false;
    if (state.sessionViewVersion !== target.viewVersion) return false;
    if (state.busySessionIds.has(target.sessionId)) return false;
    const session = byId(target.sessionId);
    return JSON.stringify([Boolean(session), session?.title, session?.updatedAt, session?.latestMessageId]) === target.recordRevision;
  }

  async function clearMessages(sessionId) {
    if (!sessionId || state.busySessionIds.has(sessionId)) return;
    const target = captureSessionMutationTarget(sessionId);
    if (
      !await confirmAction(
        `Clear all messages in "${sessionId}"? The session will stay in the list.`,
        { title: "Clear conversation", confirmLabel: "Clear messages", tone: "danger" },
      )
    )
      return;
    if (!isCurrentSessionMutationTarget(target)) return;
    const scope = { environmentId: target.environmentId, sessionId };
    setBusy(sessionId, true);
    try {
      await client.clearSessionMessages(sessionId, scope.environmentId);
      onSessionAttachmentsCleared(scope);
      if (selectedEnvironmentId() !== scope.environmentId) return;
      onClearSessionMode(sessionId);
      if (state.currentSessionId === sessionId) onClearCurrent(false);
      await onReload();
    } catch (error) {
      if (selectedEnvironmentId() !== scope.environmentId) return;
      onControlEvent({
        type: "control",
        name: "Session clear failed",
        tone: "failed",
        summary: error instanceof Error ? error.message : String(error),
      });
    } finally {
      state.busySessionIds.delete(sessionId);
      if (selectedEnvironmentId() === scope.environmentId) render();
    }
  }

  async function deleteSession(sessionId) {
    if (!sessionId || state.busySessionIds.has(sessionId)) return;
    const target = captureSessionMutationTarget(sessionId);
    if (
      !await confirmAction(
        `Delete "${sessionId}" from this environment and the server?`,
        { title: "Delete conversation", confirmLabel: "Delete conversation", tone: "danger" },
      )
    )
      return;
    if (!isCurrentSessionMutationTarget(target)) return;
    const scope = { environmentId: target.environmentId, sessionId };
    setBusy(sessionId, true);
    try {
      await client.deleteSession(sessionId, scope.environmentId);
      onSessionAttachmentsCleared(scope);
      if (selectedEnvironmentId() !== scope.environmentId) return;
      void updatePinnedSessions((pins) => pins.filter((item) => item !== sessionId))
        .then(() => { if (selectedEnvironmentId() === scope.environmentId) render(); })
        .catch(() => {
          if (selectedEnvironmentId() === scope.environmentId)
            shell.showToast("Conversation deleted, but its saved pin could not be removed", "failed");
        });
      onClearSessionMode(sessionId);
      delete state.sessionModels[sessionId];
      onSaveModelPreferences();
      if (
        preferences.sessionIdForEnvironment(scope.environmentId) ===
        sessionId
      ) {
        preferences.saveSessionIdForEnvironment(scope.environmentId, "");
      }
      state.sessions = state.sessions.filter(
        (session) => session.id !== sessionId,
      );
      if (state.currentSessionId === sessionId) onClearCurrent(true);
      render();
      await onReload();
    } catch (error) {
      if (selectedEnvironmentId() !== scope.environmentId) return;
      onControlEvent({
        type: "control",
        name: "Session delete failed",
        tone: "failed",
        summary: error instanceof Error ? error.message : String(error),
      });
    } finally {
      state.busySessionIds.delete(sessionId);
      if (selectedEnvironmentId() === scope.environmentId) render();
    }
  }

  return {
    setPagination: (value) => { pagination = value; },
    paginationQuery: () => ({ ...sidebar.paginationQuery(), ...(client?.supportsProjects?.() ? { sidebar: true } : {}) }),
    archiveSession: (sessionId) => sidebar.archiveSession(sessionId),
    applyReadState,
    applyTitle,
    byId,
    clearMessages,
    deleteSession,
    forgetDeletedSessionPins(sessionIds) {
      const deleted = new Set(sessionIds);
      return updatePinnedSessions((pins) => pins.filter((id) => !deleted.has(id)));
    },
    render,
    setBusy,
    setCurrentTitle,
    titleOf,
    togglePinned,
  };
}
