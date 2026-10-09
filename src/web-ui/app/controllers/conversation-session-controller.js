import {
  captureContextReplayScope,
  bindContextReplayEvents,
  isContextReplayCurrent,
} from "../lib/context-window-replay.js";
import { synchronizeContextRequestLifecycle } from "../lib/context-window-state.js";
import { createSessionListPagination } from "./session-list-pagination.js";
import { createHistoryPagination, canRestoreSnapshotQueue } from "./history-pagination.js";
import { createConversationReadStateController } from "./conversation-read-state-controller.js";
import { createConversationRequestHydration } from "./conversation-request-hydration.js";
import { normalizeScheduleReference } from "../lib/schedule-message.js";
import { createWebSessionId, textOf } from "../lib/text-format.js";
import { insertRequestUserMessageBeforeAssistant } from "../ui-behavior.js";
import { normalizeRealtimeMessage } from "../lib/realtime-message.js";
import {
  sparkProposalId,
  sparkHandoffAvailable,
} from "../lib/spark-proposal-message.js";
import {
  isApprovalPresentation,
  requestLifecycles,
  rememberRequestLifecycle,
  sameConversationMessage,
  mergeConversationMessage,
} from "../lib/request-lifecycle-view.js";

export function normalizeConversationMessage(raw, fallbackIndex = 0) {
  const message =
    raw?.message && typeof raw.message === "object" ? raw.message : raw;
  return {
    id: textOf(message?.id) || `local-${fallbackIndex + 1}`,
    persistedMessageId: message?.id ?? null,
    kind: textOf(message?.kind),
    approvalRequest: message?.approvalRequest,
    role: textOf(message?.role, "assistant"),
    text: textOf(message?.text ?? message?.content ?? message?.output),
    createdAt: message?.createdAt || Date.now(),
    requestId: textOf(message?.requestId),
    streaming: false,
    schedule: normalizeScheduleReference(message?.schedule),
    sparkProposalId: sparkProposalId(message),
    sparkHandoffAvailable: sparkHandoffAvailable(message),
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
  isConversationVisible = () => true,
  onSessionListState = () => {},
  scheduleTask = (callback) => window.setTimeout(callback, 0),
  createSessionId = createWebSessionId,
  onSessionCreated = () => {},
}) {
  let environmentLoadRevision = 0;
  const listPagination = createSessionListPagination({ state, dom, client, sessions, selectedEnvironmentId, renderSessions, onSessionListState });
  const history = createHistoryPagination({ state, dom, client, selectedEnvironmentId,
    normalizeMessage: normalizeConversationMessage, renderMessages, conversationView, applyReadState: sessions.applyReadState,
    onRequests: (requests) => restoreSessionEventState(requests, new Set(), true),
    loadLatest: () => openSession(state.currentSessionId, { preserveCurrentWindow: true }),
    onNewerPage: (messages) => markDisplayedMessagesReadSoon(messages),
  });
  let sessionRestoreRevision = 0;

  function invalidateEnvironmentLoads() {
    environmentLoadRevision += 1;
    listPagination.invalidate();
    history.reset();
    sessionRestoreRevision += 1;
    state.sessions = [];
    onSessionListState({ status: "loading", sessions: [] });
    renderSessions();
  }

  function normalizeMessage(raw) {
    return normalizeConversationMessage(raw, state.messages.length);
  }

  const { markCurrentSessionReadSoon, markDisplayedMessagesReadSoon } = createConversationReadStateController({
    state,
    client,
    selectedEnvironmentId,
    applyReadState: sessions.applyReadState,
    recordControlEvent,
    isConversationVisible,
    scheduleTask,
  });
  const requestHydration = createConversationRequestHydration({
    state, client, selectedEnvironmentId, sessionQueue, applyConversationChrome, renderSessions,
    updateComposerSendState, reportQueueFailure, activeAssistantForRequest, restoreSessionEventState,
    subscribeSession, subscribeRequest, replayRequestEvents, resumeRequest, recoverBlockedQueue, drainQueuedMessage, renderMessages,
  });

  function addOrMergeMessage(message) {
    const id = textOf(message.id);
    const requestId = textOf(message.requestId);
    const existingIndex = state.messages.findIndex((item) =>
      sameConversationMessage(item, message),
    );
    if (existingIndex >= 0) {
      state.messages[existingIndex] = mergeConversationMessage(state.messages[existingIndex], message);
    } else {
      state.messages.push(message);
    }
    if (
      requestId &&
      message.role === "assistant" &&
      !isApprovalPresentation(message)
    ) {
      state.requestMessages.set(requestId, message.id);
    }
  }

  function activeAssistantForRequest(requestId) {
    const existingId = state.requestMessages.get(requestId);
    const existing = state.messages.find(
      (message) => message.id === existingId,
    );
    if (existing && !isApprovalPresentation(existing)) return existing;

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
    history.reset();
    state.events = [];
    state.taskProgressByRequest.clear();
    state.contextWindowByRequest.clear();
    state.activeRequestId = "";
    state.composerSending = false;
    conversationView.reset();
    state.submittedToolApprovalIds.clear();
    state.requestMessages.clear();
    requestLifecycles(state).clear();
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
      requestLifecycles(state).has(requestId) ||
      (state.activeRequestId && requestId === state.activeRequestId),
    );
  }

  function shouldAcceptRealtimeMessage(message) {
    const sessionId = textOf(message.sessionId);
    if (sessionId && sessionId !== state.currentSessionId) {
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
          message.role === "assistant" &&
          message.requestId === requestId &&
          !isApprovalPresentation(message),
      );
      if (assistant) assistant.thinkingText = thinkingText;
    }
  }

  function restoreSessionEventState(
    requests = [],
    hydrateRequestIds = new Set(),
    append = false,
  ) {
    if (!append) {
      state.events = [];
      state.taskProgressByRequest.clear();
      state.contextWindowByRequest.clear();
    }
    const requestEvents = [];
    for (const request of requests) {
      rememberRequestLifecycle(state, request.lifecycle);
      if (!Array.isArray(request.events)) continue;
      const replayScope = captureContextReplayScope(
        state,
        selectedEnvironmentId(),
        request.requestId,
      );
      const normalizedEvents = bindContextReplayEvents(
        request.events,
        replayScope,
      );
      requestEvents.push(...normalizedEvents);
    }
    hydrateThinkingTextFromEvents(requestEvents, hydrateRequestIds);
    for (const event of requestEvents) {
      if (hydrateRequestIds.has(event.requestId)) handleRealtimeMessage(event);
      else recordEvent(event);
    }
    for (const request of requests) {
      if (!request.lifecycle) continue;
      synchronizeContextRequestLifecycle(
        state,
        { name: "request.lifecycle.changed", lifecycle: request.lifecycle },
        selectedEnvironmentId(),
      );
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
    const hasActiveRequestInSession =
      sessionId === state.currentSessionId && Boolean(state.activeRequestId);
    if (hasActiveRequestInSession) resumeRequest(state.activeRequestId);
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
    const replayScope = captureContextReplayScope(
      state,
      selectedEnvironmentId(),
      requestId,
    );
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
    if (!isContextReplayCurrent(replayScope, state, selectedEnvironmentId()))
      return;
    if (afterSeq === 0) resetAssistantForReplay(requestId);
    for (const event of bindContextReplayEvents(events, replayScope))
      handleRealtimeMessage(event);
  }

  const loadSessions = () => listPagination.load();

  async function restoreLastSession() {
    const environmentRevision = environmentLoadRevision;
    const restoreRevision = ++sessionRestoreRevision;
    const environmentId = selectedEnvironmentId();
    const availableSessions = await loadSessions();
    if (
      environmentRevision !== environmentLoadRevision ||
      restoreRevision !== sessionRestoreRevision ||
      environmentId !== selectedEnvironmentId() ||
      state.currentSessionId
    ) {
      return;
    }
    const savedSessionId = preferences.sessionIdForEnvironment(environmentId);
    const targetId = savedSessionId || availableSessions[0]?.id;
    if (!targetId) return;
    try { await openSession(targetId); }
    catch (error) {
      if (error.code !== "session_not_found") throw error;
      if (availableSessions[0]?.id && availableSessions[0].id !== targetId) await openSession(availableSessions[0].id);
    }
  }

  async function openSession(
    sessionId,
    { isRouteCurrent, commitRouteNavigation, snapshot, page, preserveCurrentWindow = false } = {},
  ) {
    const routeOwned = typeof commitRouteNavigation === "function";
    const loadBeforeReset = routeOwned || preserveCurrentWindow;
    let payload;
    const pageOptions = { ...page, waitingRequestId: sessionQueue.peek({ environmentId: selectedEnvironmentId(), sessionId })?.waitForRequestId };
    const prefetched = canRestoreSnapshotQueue(snapshot, pageOptions.waitingRequestId) ? snapshot : undefined;
    if (loadBeforeReset) {
      const environmentId = selectedEnvironmentId();
      const viewVersion = state.sessionViewVersion;
      const currentSessionId = state.currentSessionId;
      payload = prefetched ?? await client.loadSession(sessionId, environmentId, pageOptions);
      if (environmentId !== selectedEnvironmentId()) return;
      if (viewVersion !== state.sessionViewVersion) return;
      if (currentSessionId !== state.currentSessionId) return;
      if (routeOwned && isRouteCurrent?.() !== true) return;
    }
    if (
      state.currentSessionId &&
      state.currentSessionId !== sessionId &&
      !suspendQueueRecovery()
    ) {
      return;
    }
    if (routeOwned && commitRouteNavigation() !== true) return;
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

    if (!loadBeforeReset) {
      payload = prefetched ?? await client.loadSession(sessionId, selectedEnvironmentId(), pageOptions);
    }
    if (
      state.currentSessionId !== sessionId ||
      state.sessionViewVersion !== viewVersion
    ) {
      return;
    }
    history.adopt(payload);
    const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
    state.messages = rawMessages.map((message, index) =>
      normalizeConversationMessage(message, index),
    );
    const displayedPage = [...state.messages];
    sessions.applyTitle(sessionId, payload.title);
    sessions.applyReadState(sessionId, payload.readState);
    const requests = Array.isArray(payload.requests) ? payload.requests : [];
    if (!await requestHydration.restore(requests)) return;
    markDisplayedMessagesReadSoon(displayedPage);
  }

  function ensureSession() {
    if (state.currentSessionId) return state.currentSessionId;
    state.currentSessionId = createSessionId();
    onSessionCreated(state.currentSessionId);
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
    history,
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
    invalidateEnvironmentLoads,
    loadSessions,
    markCurrentSessionReadSoon,
    rehydrateRequests: requestHydration.rehydrate,
    normalizeMessage,
    openSession,
    requestBelongsToCurrentView,
    resetLiveRequestView,
    restoreLastSession,
    shouldAcceptRealtimeMessage,
    subscribeSession,
  };
}
