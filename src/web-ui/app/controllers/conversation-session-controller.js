import { createWebSessionId, escapeHtml, textOf } from "../lib/text-format.js";
import { insertRequestUserMessageBeforeAssistant } from "../ui-behavior.js";
import { normalizeRealtimeMessage } from "../lib/realtime-message.js";

export function normalizeConversationMessage(raw, fallbackIndex = 0) {
  const message =
    raw?.message && typeof raw.message === "object" ? raw.message : raw;
  return {
    id: textOf(message?.id) || `local-${fallbackIndex + 1}`,
    role: textOf(message?.role, "assistant"),
    text: textOf(message?.text ?? message?.content ?? message?.output),
    createdAt: message?.createdAt || Date.now(),
    requestId: textOf(message?.requestId),
    streaming: false,
    events: Array.isArray(message?.events)
      ? message.events.map((event) => textOf(event)).filter(Boolean)
      : [],
    attachments: Array.isArray(message?.attachments)
      ? message.attachments.filter(Boolean)
      : [],
  };
}

export function createConversationSessionController({
  state,
  dom,
  client,
  preferences,
  sessions,
  sessionQueue,
  conversationView,
  selectedEnvironmentId,
  clearPendingAttachments,
  applyConversationChrome,
  applyModelSelection,
  renderSessions,
  renderMessages,
  updateComposerSendState,
  setMessageStatus,
  sendRealtime,
  handleRealtimeMessage,
  recordEvent,
  recordControlEvent,
  reportQueueFailure,
  drainQueuedMessage,
  suspendQueueRecovery,
  recoverBlockedQueue,
  isCurrentComposerScope,
  scheduleTask = (callback) => window.setTimeout(callback, 0),
  createSessionId = createWebSessionId,
}) {
  function normalizeMessage(raw) {
    return normalizeConversationMessage(raw, state.messages.length);
  }

  function latestAssistantMessageId() {
    let latest = 0;
    for (const message of state.messages) {
      if (message.role !== "assistant") continue;
      const numericId = Number(textOf(message.id).replace(/^msg-/, ""));
      if (Number.isFinite(numericId)) {
        latest = Math.max(latest, Math.floor(numericId));
      }
    }
    return latest > 0 ? latest : null;
  }

  async function markSessionRead(sessionId, readThroughMessageId = null) {
    if (!sessionId) return;
    const result = await client.markSessionRead({
      sessionId,
      environmentId: selectedEnvironmentId(),
      readThroughMessageId,
    });
    sessions.applyReadState(sessionId, result.readState);
  }

  function markCurrentSessionReadSoon() {
    const sessionId = state.currentSessionId;
    if (!sessionId) return;
    const readThroughMessageId = latestAssistantMessageId();
    scheduleTask(() => {
      if (state.currentSessionId !== sessionId) return;
      void markSessionRead(sessionId, readThroughMessageId).catch((error) => {
        recordControlEvent({
          type: "control",
          name: "Read state update failed",
          tone: "failed",
          summary: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  function addOrMergeMessage(message) {
    const id = textOf(message.id);
    const requestId = textOf(message.requestId);
    const existingIndex = state.messages.findIndex((item) => {
      if (id && item.id === id) return true;
      return Boolean(
        requestId &&
        item.requestId === requestId &&
        item.role === message.role &&
        item.role === "assistant",
      );
    });
    if (existingIndex >= 0) {
      state.messages[existingIndex] = {
        ...state.messages[existingIndex],
        ...message,
        text: message.text || state.messages[existingIndex].text,
        thinkingText:
          message.thinkingText || state.messages[existingIndex].thinkingText,
      };
    } else {
      state.messages.push(message);
    }
    if (requestId && message.role === "assistant") {
      state.requestMessages.set(requestId, message.id);
    }
  }

  function activeAssistantForRequest(requestId) {
    const existingId = state.requestMessages.get(requestId);
    const existing = state.messages.find(
      (message) => message.id === existingId,
    );
    if (existing) return existing;

    const message = {
      id: `assistant-${requestId}`,
      role: "assistant",
      text: "",
      createdAt: Date.now(),
      requestId,
      streaming: true,
      thinkingText: "",
    };
    state.messages.push(message);
    state.requestMessages.set(requestId, message.id);
    return message;
  }

  function resetLiveRequestView() {
    state.events = [];
    state.taskProgressByRequest.clear();
    state.contextWindowByRequest.clear();
    state.activeRequestId = "";
    conversationView.reset();
    state.submittedToolApprovalIds.clear();
    state.requestMessages.clear();
    state.sessionViewVersion += 1;
    setMessageStatus("");
    updateComposerSendState();
    renderMessages();
  }

  function clearCurrentSessionView() {
    state.currentSessionId = "";
    state.messages = [];
    clearPendingAttachments();
    resetLiveRequestView();
    dom.sessionTitle.textContent = "New conversation";
    applyConversationChrome();
    renderMessages();
  }

  function clearSessionMessagesView() {
    state.messages = [];
    clearPendingAttachments();
    resetLiveRequestView();
    applyConversationChrome();
    renderMessages();
  }

  function requestBelongsToCurrentView(requestId) {
    if (!requestId) return true;
    return Boolean(
      state.activeRequestId && requestId === state.activeRequestId,
    );
  }

  function shouldAcceptRealtimeMessage(message) {
    const sessionId = textOf(message.sessionId);
    if (
      sessionId &&
      state.currentSessionId &&
      sessionId !== state.currentSessionId
    ) {
      return false;
    }
    const requestId = textOf(message.requestId);
    if (!requestId) return true;
    return requestBelongsToCurrentView(requestId);
  }

  function eventMessageFromMarker(marker, message) {
    const [name = "", detail = "", phase = "", rawMeta = ""] =
      textOf(marker).split("|");
    let meta = null;
    try {
      meta = rawMeta ? JSON.parse(decodeURIComponent(rawMeta)) : null;
    } catch {
      meta = null;
    }
    return {
      type: "event",
      requestId: message.requestId,
      name,
      tool: name.startsWith("tool.") ? detail : "",
      status: name.startsWith("tool.") ? phase : detail,
      phase: name.startsWith("tool.") ? "" : phase,
      ...(meta && typeof meta === "object" ? meta : {}),
    };
  }

  function hydrateThinkingTextFromEvents(events, hydrateRequestIds) {
    const thinkingByRequest = new Map();
    for (const event of events) {
      if (event.name !== "thinking.delta" || !event.requestId) continue;
      const current = thinkingByRequest.get(event.requestId) || "";
      const accumulated = textOf(event.text);
      const delta = textOf(event.delta);
      const next = accumulated || `${current}${delta}`;
      if (next.trim()) thinkingByRequest.set(event.requestId, next);
    }

    for (const [requestId, thinkingText] of thinkingByRequest) {
      if (hydrateRequestIds.has(requestId)) continue;
      const assistant = state.messages.find(
        (message) =>
          message.role === "assistant" && message.requestId === requestId,
      );
      if (assistant) assistant.thinkingText = thinkingText;
    }
  }

  function restoreSessionEventState(
    requests = [],
    hydrateRequestIds = new Set(),
  ) {
    state.events = [];
    state.taskProgressByRequest.clear();
    state.contextWindowByRequest.clear();
    const requestEvents = [];
    for (const request of requests) {
      if (!Array.isArray(request.events)) continue;
      const normalizedEvents = request.events.map(normalizeRealtimeMessage);
      normalizedEvents.sort((left, right) => {
        const leftTime =
          typeof left.timestamp === "number" ? left.timestamp : 0;
        const rightTime =
          typeof right.timestamp === "number" ? right.timestamp : 0;
        return (left.seqNo || 0) - (right.seqNo || 0) || leftTime - rightTime;
      });
      requestEvents.push(...normalizedEvents);
    }
    hydrateThinkingTextFromEvents(requestEvents, hydrateRequestIds);
    for (const event of requestEvents) {
      if (hydrateRequestIds.has(event.requestId)) handleRealtimeMessage(event);
      else recordEvent(event);
    }
    if (requestEvents.length === 0) {
      for (const message of state.messages) {
        for (const marker of message.events || []) {
          const eventMessage = eventMessageFromMarker(marker, message);
          if (eventMessage.name) recordEvent(eventMessage);
        }
      }
    }
    renderMessages();
  }

  function subscribeSession(sessionId) {
    sendRealtime({
      type: "subscribe_session",
      sessionId,
      environment: selectedEnvironmentId(),
    });
  }

  function subscribeRequest(requestId) {
    sendRealtime({ type: "subscribe_request", requestId });
  }

  function resumeRequest(requestId) {
    sendRealtime({
      type: "resume_request",
      requestId,
      afterSeq: state.lastSeqByRequest.get(requestId) || 0,
      environment: selectedEnvironmentId(),
    });
  }

  async function fetchRequestEvents(requestId, afterSeq = 0) {
    const rawEvents = await client.fetchRequestEvents({
      requestId,
      afterSeq,
      environmentId: selectedEnvironmentId(),
    });
    return rawEvents
      .map(normalizeRealtimeMessage)
      .filter((event) => event.requestId === requestId)
      .sort((left, right) => (left.seqNo || 0) - (right.seqNo || 0));
  }

  function resetAssistantForReplay(requestId) {
    const assistant = activeAssistantForRequest(requestId);
    assistant.text = "";
    assistant.thinkingText = "";
    assistant.streaming = true;
  }

  async function replayRequestEvents(requestId, viewVersion) {
    const afterSeq = state.lastSeqByRequest.get(requestId) || 0;
    let events = [];
    try {
      events = await fetchRequestEvents(requestId, afterSeq);
    } catch (error) {
      if (state.sessionViewVersion !== viewVersion) return;
      recordControlEvent({
        type: "control",
        name: "Replay unavailable",
        tone: "failed",
        summary: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (
      state.sessionViewVersion !== viewVersion ||
      !requestBelongsToCurrentView(requestId) ||
      events.length === 0
    ) {
      return;
    }
    if (afterSeq === 0) resetAssistantForReplay(requestId);
    for (const event of events) handleRealtimeMessage(event);
  }

  async function loadSessions() {
    try {
      const payload = await client.listSessions(selectedEnvironmentId());
      state.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      renderSessions();
      return state.sessions;
    } catch (error) {
      dom.sessionsList.innerHTML = `<div class="empty-state error-text">${escapeHtml(
        error instanceof Error ? error.message : String(error),
      )}</div>`;
      return [];
    }
  }

  async function restoreLastSession() {
    const availableSessions = await loadSessions();
    if (availableSessions.length === 0 || state.currentSessionId) return;
    const environmentId = selectedEnvironmentId();
    const savedSessionId = preferences.sessionIdForEnvironment(environmentId);
    const targetSession =
      availableSessions.find((session) => session.id === savedSessionId) ||
      availableSessions[0];
    if (targetSession?.id) await openSession(targetSession.id);
  }

  async function openSession(sessionId) {
    if (
      state.currentSessionId &&
      state.currentSessionId !== sessionId &&
      !suspendQueueRecovery()
    ) {
      return;
    }
    const viewVersion = state.sessionViewVersion + 1;
    state.currentSessionId = sessionId;
    preferences.saveSessionIdForEnvironment(selectedEnvironmentId(), sessionId);
    state.messages = [];
    clearPendingAttachments();
    resetLiveRequestView();
    state.sessionViewVersion = viewVersion;
    sessions.setCurrentTitle(
      sessions.titleOf(sessions.byId(sessionId)) || sessionId,
    );
    applyConversationChrome();
    applyModelSelection();
    renderSessions();
    renderMessages();
    subscribeSession(sessionId);

    const payload = await client.loadSession(
      sessionId,
      selectedEnvironmentId(),
    );
    if (
      state.currentSessionId !== sessionId ||
      state.sessionViewVersion !== viewVersion
    ) {
      return;
    }
    const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
    const scope = { environmentId: selectedEnvironmentId(), sessionId };
    state.messages = rawMessages.map((message, index) =>
      normalizeConversationMessage(message, index),
    );
    sessions.applyTitle(sessionId, payload.title);
    sessions.applyReadState(sessionId, payload.readState);
    for (const message of state.messages) {
      if (message.role === "assistant" && message.requestId) {
        state.requestMessages.set(message.requestId, message.id);
      }
    }
    const requests = Array.isArray(payload.requests) ? payload.requests : [];
    applyConversationChrome();
    renderSessions();
    const streamingRequestIds = new Set(
      requests
        .filter(
          (request) => request.status === "streaming" && request.requestId,
        )
        .map((request) => textOf(request.requestId)),
    );
    if (streamingRequestIds.size === 1) {
      const [streamingRequestId] = streamingRequestIds;
      try {
        sessionQueue.rebindBlocked(scope, streamingRequestId);
      } catch (error) {
        reportQueueFailure(
          scope,
          `The active request was restored, but the remaining Send next queue is paused: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    state.activeRequestId = [...streamingRequestIds][0] || "";
    updateComposerSendState();
    for (const requestId of streamingRequestIds) {
      activeAssistantForRequest(requestId);
    }
    restoreSessionEventState(requests, streamingRequestIds);
    for (const request of requests) {
      if (request.status === "streaming" && request.requestId) {
        subscribeRequest(request.requestId);
        await replayRequestEvents(request.requestId, viewVersion);
        if (
          state.currentSessionId !== sessionId ||
          state.sessionViewVersion !== viewVersion
        ) {
          return;
        }
        resumeRequest(request.requestId);
      }
    }
    if (!state.activeRequestId) {
      recoverBlockedQueue(scope);
      const queued = sessionQueue.peek(scope);
      const terminal = queued
        ? requests.find(
            (request) =>
              textOf(request.requestId) === queued.waitForRequestId &&
              (request.status === "completed" || request.status === "failed"),
          )
        : null;
      if (terminal) {
        await drainQueuedMessage({
          ...scope,
          terminalRequestId: terminal.requestId,
        });
      }
    }
    renderMessages();
    markCurrentSessionReadSoon();
  }

  function ensureSession() {
    if (state.currentSessionId) return state.currentSessionId;
    state.currentSessionId = createSessionId();
    preferences.saveSessionIdForEnvironment(
      selectedEnvironmentId(),
      state.currentSessionId,
    );
    sessions.setCurrentTitle(state.currentSessionId);
    subscribeSession(state.currentSessionId);
    return state.currentSessionId;
  }

  function appendLocalUserMessage({ text, attachments, requestId = "" }) {
    state.messages.push({
      id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: "user",
      text,
      createdAt: Date.now(),
      requestId,
      streaming: false,
      attachments,
    });
    renderMessages();
  }

  function insertSteerMessage({ steerId, requestId, text }) {
    state.messages = insertRequestUserMessageBeforeAssistant(state.messages, {
      id: `steer-${steerId}`,
      role: "user",
      text,
      createdAt: Date.now(),
      requestId,
      streaming: false,
      attachments: [],
    });
    renderMessages();
  }

  function appendRequestError(error) {
    state.messages.push({
      id: `error-${Date.now()}`,
      role: "assistant",
      text: error instanceof Error ? error.message : String(error),
      createdAt: Date.now(),
      requestId: "",
      streaming: false,
    });
    renderMessages();
  }

  function activateRequestForScope(scope, requestId) {
    if (!isCurrentComposerScope(scope)) return;
    state.activeRequestId = requestId;
    activeAssistantForRequest(requestId);
    subscribeRequest(requestId);
    resumeRequest(requestId);
    updateComposerSendState();
    renderMessages();
  }

  return {
    activateRequestForScope,
    activeAssistantForRequest,
    addOrMergeMessage,
    appendLocalUserMessage,
    appendRequestError,
    applySessionReadState: sessions.applyReadState,
    applySessionTitleUpdate: sessions.applyTitle,
    clearCurrentSessionView,
    clearSessionMessagesView,
    ensureSession,
    insertSteerMessage,
    loadSessions,
    markCurrentSessionReadSoon,
    normalizeMessage,
    openSession,
    requestBelongsToCurrentView,
    resetLiveRequestView,
    restoreLastSession,
    shouldAcceptRealtimeMessage,
    subscribeSession,
  };
}
