import { matchesSessionQuery } from "../ui-behavior.js";
import { escapeAttribute, escapeHtml, textOf } from "../lib/text-format.js";
import { getNumber } from "../lib/event-presentation.js";

export function createSessionController({
  state,
  dom,
  sessionActionsMenu,
  shell,
  preferences,
  client,
  selectedEnvironmentId,
  onOpen,
  onClearCurrent,
  onClearSessionMode,
  onSaveModelPreferences,
  onReload,
  onControlEvent,
  confirmAction = window.confirm.bind(window),
  copyText = (value) => navigator.clipboard.writeText(value),
}) {
  const titleOf = (session) =>
    textOf(session?.displayName || session?.title || session?.id);
  const byId = (sessionId) =>
    state.sessions.find((session) => textOf(session.id) === sessionId);
  const isPinned = (sessionId) => state.pinnedSessionIds.includes(sessionId);

  function ordered() {
    const pinnedOrder = new Map(
      state.pinnedSessionIds.map((sessionId, index) => [sessionId, index]),
    );
    return [...state.sessions].sort((left, right) => {
      const leftPinned = pinnedOrder.has(left.id);
      const rightPinned = pinnedOrder.has(right.id);
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
      if (leftPinned && rightPinned) {
        return pinnedOrder.get(left.id) - pinnedOrder.get(right.id);
      }
      return 0;
    });
  }

  function filtered() {
    return ordered().filter((session) =>
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
    sessionActionsMenu.reset();
    dom.sessionsList.innerHTML = "";
    const sessions = filtered();
    dom.sessionsCount.textContent = String(sessions.length);
    if (state.sessions.length === 0) {
      dom.sessionsList.innerHTML = `
        <div class="empty-state sidebar-empty-state">
          <strong>No conversations yet</strong>
          <span>Start a new conversation to keep its history here.</span>
        </div>
      `;
      return;
    }
    if (sessions.length === 0) {
      dom.sessionsList.innerHTML = `
        <div class="empty-state sidebar-empty-state compact">
          <strong>No matches</strong>
          <span>Try a different conversation name or message.</span>
        </div>
      `;
      return;
    }
    for (const [sessionIndex, session] of sessions.entries()) {
      const sessionId = textOf(session.id);
      const pinned = isPinned(sessionId);
      const busy = state.busySessionIds.has(sessionId);
      const unreadCount = getNumber(session.unreadCount, 0);
      const hasUnread = session.hasUnread === true || unreadCount > 0;
      const item = document.createElement("div");
      item.className = `session-item ${
        session.id === state.currentSessionId ? "active" : ""
      } ${pinned ? "pinned" : ""} ${busy ? "busy" : ""} ${
        hasUnread ? "unread" : ""
      }`;
      item.innerHTML = `
        <button class="session-open-button" type="button" title="${escapeAttribute(titleOf(session))}">
          <div class="session-title-row">
            <div class="session-title" dir="auto">${escapeHtml(titleOf(session))}</div>
            ${
              hasUnread
                ? `<span class="session-unread-badge" title="${escapeAttribute(
                    `${unreadCount || 1} unread`,
                  )}">${unreadCount > 99 ? "99+" : unreadCount || 1}</span>`
                : ""
            }
          </div>
        </button>
        <div class="session-actions" aria-label="Session actions">
          <button class="session-menu-button" type="button" title="Session actions" aria-label="Session actions" aria-haspopup="menu" aria-expanded="false" aria-controls="session-menu-${sessionIndex}">•••</button>
          <div id="session-menu-${sessionIndex}" class="session-menu" role="menu" hidden>
            <button class="session-action pin-action" type="button" role="menuitem" tabindex="-1" title="${pinned ? "Unpin session" : "Pin session"}">${pinned ? "Unpin" : "Pin"}</button>
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
      dom.sessionsList.appendChild(item);
    }
  }

  function setCurrentTitle(title) {
    if (state.currentSessionId) {
      dom.sessionTitle.textContent = title || state.currentSessionId;
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
    const value = readState && typeof readState === "object" ? readState : {};
    const normalizedSessionId = textOf(value.sessionId || sessionId);
    if (!normalizedSessionId) return false;
    const unreadCount = getNumber(value.unreadCount, 0);
    const normalized = {
      sessionId: normalizedSessionId,
      lastReadMessageId: textOf(value.lastReadMessageId),
      lastReadAt: value.lastReadAt || null,
      unreadCount,
      hasUnread: value.hasUnread === true || unreadCount > 0,
      latestMessageId: textOf(value.latestMessageId),
      latestAssistantMessageId: textOf(value.latestAssistantMessageId),
    };
    let changed = false;
    state.sessions = state.sessions.map((session) => {
      if (textOf(session.id) !== normalized.sessionId) return session;
      changed = true;
      return {
        ...session,
        readState: normalized,
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
    if (changed) render();
    return changed;
  }

  function setBusy(sessionId, busy) {
    if (busy) state.busySessionIds.add(sessionId);
    else state.busySessionIds.delete(sessionId);
    render();
  }

  function togglePinned(sessionId) {
    if (!sessionId) return;
    state.pinnedSessionIds = isPinned(sessionId)
      ? state.pinnedSessionIds.filter((item) => item !== sessionId)
      : [sessionId, ...state.pinnedSessionIds];
    preferences.savePinnedSessions(state.pinnedSessionIds);
    render();
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

  async function clearMessages(sessionId) {
    if (!sessionId || state.busySessionIds.has(sessionId)) return;
    if (
      !confirmAction(
        `Clear all messages in "${sessionId}"? The session will stay in the list.`,
      )
    )
      return;
    setBusy(sessionId, true);
    try {
      await client.clearSessionMessages(sessionId, selectedEnvironmentId());
      onClearSessionMode(sessionId);
      if (state.currentSessionId === sessionId) onClearCurrent(false);
      await onReload();
    } catch (error) {
      onControlEvent({
        type: "control",
        name: "Session clear failed",
        tone: "failed",
        summary: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(sessionId, false);
    }
  }

  async function deleteSession(sessionId) {
    if (!sessionId || state.busySessionIds.has(sessionId)) return;
    if (
      !confirmAction(
        `Delete "${sessionId}" from this environment and the server?`,
      )
    )
      return;
    setBusy(sessionId, true);
    try {
      await client.deleteSession(sessionId, selectedEnvironmentId());
      state.pinnedSessionIds = state.pinnedSessionIds.filter(
        (item) => item !== sessionId,
      );
      preferences.savePinnedSessions(state.pinnedSessionIds);
      onClearSessionMode(sessionId);
      delete state.sessionModels[sessionId];
      onSaveModelPreferences();
      if (
        preferences.sessionIdForEnvironment(selectedEnvironmentId()) ===
        sessionId
      ) {
        preferences.saveSessionIdForEnvironment(selectedEnvironmentId(), "");
      }
      state.sessions = state.sessions.filter(
        (session) => session.id !== sessionId,
      );
      if (state.currentSessionId === sessionId) onClearCurrent(true);
      render();
      await onReload();
    } catch (error) {
      onControlEvent({
        type: "control",
        name: "Session delete failed",
        tone: "failed",
        summary: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(sessionId, false);
    }
  }

  return {
    applyReadState,
    applyTitle,
    byId,
    clearMessages,
    deleteSession,
    render,
    setBusy,
    setCurrentTitle,
    titleOf,
    togglePinned,
  };
}
