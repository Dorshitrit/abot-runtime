import { isMatchingActiveRequest } from "../ui-behavior.js";
import {
  eventKeyFor,
  eventTone,
  formatEventDetail,
  formatEventLabel,
  getPlanItemPayload,
  getPlanPayload,
  getRecord,
  isLowValueActivityEvent,
} from "../lib/event-presentation.js";
import { textOf } from "../lib/text-format.js";
import { normalizeRealtimeMessage } from "../lib/realtime-message.js";

export { normalizeRealtimeMessage } from "../lib/realtime-message.js";

export function taskStatusClass(status) {
  const normalized = textOf(status).trim().toLowerCase();
  if (normalized === "done" || normalized === "completed") return "done";
  if (normalized === "in_progress" || normalized === "active") {
    return "active";
  }
  if (normalized === "blocked" || normalized === "failed") return "failed";
  if (normalized === "superseded") return "muted";
  return "pending";
}

export function createRealtimeEventController({
  state,
  shell,
  selectedEnvironmentId,
  handleSteerAcknowledgement,
  shouldAcceptMessage,
  applySessionReadState,
  activeAssistantForRequest,
  addOrMergeMessage,
  normalizeChatMessage,
  renderMessages,
  scheduleMessageRender,
  scheduleThinkingRender,
  cancelScheduledMessageRender,
  cancelScheduledThinkingRender,
  forgetThinkingDisclosure,
  markCurrentSessionReadSoon,
  applySessionTitleUpdate,
  setMessageActivityStatus,
  updateComposerSendState,
  drainQueuedComposerMessage,
  loadSessions,
}) {
  function trackSeq(message) {
    if (message.requestId && typeof message.seqNo === "number") {
      state.lastSeqByRequest.set(message.requestId, message.seqNo);
    }
  }

  function mergeTaskProgressItem(items, nextItem) {
    const normalizedTitle = nextItem.title.trim().toLowerCase();
    const normalizedId = nextItem.id.trim();
    const existingIndex = items.findIndex((item) => {
      if (normalizedId && item.id === normalizedId) return true;
      return item.title.trim().toLowerCase() === normalizedTitle;
    });
    if (existingIndex < 0) {
      items.push(nextItem);
      return;
    }
    items[existingIndex] = {
      ...items[existingIndex],
      ...nextItem,
      id: nextItem.id || items[existingIndex].id,
      title: nextItem.title || items[existingIndex].title,
      status: nextItem.status || items[existingIndex].status,
    };
  }

  function updateTaskProgress(message) {
    const plan = getPlanPayload(message);
    const item = getPlanItemPayload(message);
    const snapshot = getRecord(message.progressSnapshot);
    const planningSignal =
      Boolean(plan || item || snapshot) ||
      textOf(message.name).startsWith("Planner ") ||
      textOf(message.name).startsWith("Development progress:");
    if (!planningSignal) return;
    const requestId = textOf(message.requestId) || state.activeRequestId;
    if (!requestId) return;
    const current = state.taskProgressByRequest.get(requestId) || {
      requestId,
      summary: "",
      total: 0,
      completed: 0,
      requestSatisfaction: "",
      items: [],
      hasSignal: false,
    };
    const next = {
      ...current,
      requestId,
      summary:
        plan?.summary || textOf(snapshot?.summary) || current.summary || "",
      total: plan?.total ?? current.total,
      completed: plan?.completed ?? current.completed,
      requestSatisfaction:
        textOf(snapshot?.requestSatisfaction) || current.requestSatisfaction,
      items: [...current.items],
      hasSignal: true,
    };
    for (const planItem of plan?.items || [])
      mergeTaskProgressItem(next.items, planItem);
    if (item) mergeTaskProgressItem(next.items, item);
    if (!next.summary && Array.isArray(snapshot?.requestedWork)) {
      next.summary =
        snapshot.requestedWork.map(textOf).filter(Boolean)[0] || "";
    }
    if (!next.total && next.items.length > 0) next.total = next.items.length;
    if (next.items.length > 0) {
      next.completed = Math.max(
        next.completed,
        next.items.filter((entry) => entry.status === "done").length,
      );
    }
    next.activeItem =
      next.items.find((entry) => taskStatusClass(entry.status) === "active")
        ?.title || "";
    state.taskProgressByRequest.set(requestId, next);
  }

  function updateContextWindow(message) {
    const eventName = textOf(message.name || message.rawType);
    const requestId = textOf(message.requestId) || state.activeRequestId;
    if (!requestId) return;
    const current = state.contextWindowByRequest.get(requestId) || {
      requestId,
      snapshot: null,
      providerUsage: null,
      pendingCompaction: null,
      lastCompaction: null,
    };
    if (eventName === "context.window.snapshot") {
      const contextWindowTokens = Number(message.contextWindowTokens);
      const estimatedInputTokens = Number(message.estimatedInputTokens);
      const usedContextPercent = Number(message.usedContextPercent);
      const remainingContextTokens = Number(message.remainingContextTokens);
      if (
        !Number.isFinite(contextWindowTokens) ||
        contextWindowTokens <= 0 ||
        !Number.isFinite(estimatedInputTokens) ||
        estimatedInputTokens < 0 ||
        !Number.isFinite(usedContextPercent)
      ) {
        return;
      }
      const previous = current.snapshot;
      const snapshot = {
        requestId,
        invocationId: textOf(message.invocationId),
        modelStep: textOf(message.modelStep),
        profileId: textOf(message.profileId),
        provider: textOf(message.provider),
        model: textOf(message.model),
        measurement: textOf(message.measurement, "estimated"),
        source: textOf(message.source, "runtime_token_estimator"),
        admissionOutcome: textOf(message.admissionOutcome),
        contextWindowTokens,
        estimatedInputTokens,
        remainingContextTokens: Number.isFinite(remainingContextTokens)
          ? remainingContextTokens
          : Math.max(0, contextWindowTokens - estimatedInputTokens),
        usedContextPercent,
        remainingContextPercent: Number(message.remainingContextPercent),
        compactionTriggerPercent: Number(message.compactionTriggerPercent),
        outputReserveTokens: Number(message.outputReserveTokens),
        safetyReserveTokens: Number(message.safetyReserveTokens),
        attachmentReserveTokens: Number(message.attachmentReserveTokens),
        formatReserveTokens: Number(message.formatReserveTokens),
      };
      let lastCompaction = current.lastCompaction;
      if (
        current.pendingCompaction &&
        previous?.profileId === snapshot.profileId &&
        snapshot.usedContextPercent < previous.usedContextPercent
      ) {
        lastCompaction = {
          beforePercent:
            current.pendingCompaction.beforePercent ??
            previous.usedContextPercent,
          afterPercent: snapshot.usedContextPercent,
        };
      }
      state.contextWindowByRequest.set(requestId, {
        ...current,
        requestId,
        snapshot,
        lastCompaction,
        pendingCompaction: lastCompaction ? null : current.pendingCompaction,
      });
      return;
    }
    if (eventName === "context.window.provider_usage") {
      state.contextWindowByRequest.set(requestId, {
        ...current,
        requestId,
        providerUsage: {
          invocationId: textOf(message.invocationId),
          modelStep: textOf(message.modelStep),
          profileId: textOf(message.profileId),
          source: textOf(message.source, "provider_reported"),
          inputTokens: Number(message.inputTokens),
          outputTokens: Number(message.outputTokens),
          totalTokens: Number(message.totalTokens),
        },
      });
      return;
    }
    if (eventName === "context.compaction.started") {
      state.contextWindowByRequest.set(requestId, {
        ...current,
        requestId,
        pendingCompaction: {
          beforePercent: Number.isFinite(Number(message.beforeUsedContextPercent))
            ? Number(message.beforeUsedContextPercent)
            : current.snapshot?.usedContextPercent,
        },
      });
      return;
    }
    if (eventName === "context.compaction.completed") {
      const beforePercent = Number(message.beforeUsedContextPercent);
      const afterPercent = Number(message.afterUsedContextPercent);
      state.contextWindowByRequest.set(requestId, {
        ...current,
        requestId,
        pendingCompaction: null,
        lastCompaction:
          Number.isFinite(beforePercent) && Number.isFinite(afterPercent)
            ? { beforePercent, afterPercent }
            : current.lastCompaction,
      });
      return;
    }
    if (eventName === "context.compaction.failed") {
      state.contextWindowByRequest.set(requestId, {
        ...current,
        requestId,
        pendingCompaction: null,
      });
    }
  }

  function recordEvent(message) {
    updateTaskProgress(message);
    updateContextWindow(message);
    const eventName = textOf(message.name || message.rawType || message.type);
    if (isLowValueActivityEvent(message)) {
      trackSeq(message);
      return;
    }
    const name = formatEventLabel(message);
    const summary = formatEventDetail(message);
    const tone = eventTone(message);
    const key = eventKeyFor(message, name, tone);
    const requestId = textOf(message.requestId) || state.activeRequestId;
    const lastEvent = state.events[state.events.length - 1];
    if (lastEvent?.key && lastEvent.key === key) {
      lastEvent.count = (lastEvent.count || 1) + 1;
      lastEvent.summary = summary;
      lastEvent.updatedAt = Date.now();
      if (typeof message.seqNo === "number")
        lastEvent.lastSeqNo = message.seqNo;
      lastEvent.eventName = eventName || lastEvent.eventName;
      lastEvent.tool = textOf(message.tool) || lastEvent.tool;
      lastEvent.approvalId = textOf(message.approvalId) || lastEvent.approvalId;
    } else {
      state.events.push({
        key,
        requestId,
        count: 1,
        lastSeqNo:
          typeof message.seqNo === "number" ? message.seqNo : undefined,
        updatedAt: Date.now(),
        type: message.type,
        rawType: message.rawType,
        eventName,
        name,
        summary,
        tone,
        tool: textOf(message.tool),
        approvalId: textOf(message.approvalId),
        payload: {
          plan: message.plan,
          item: message.item,
          progressSnapshot: message.progressSnapshot,
        },
      });
    }
    if (state.events.length > 1_200) {
      state.events.splice(0, state.events.length - 1_200);
    }
    trackSeq(message);
    scheduleMessageRender();
    if (eventName.startsWith("tool.approval.")) renderMessages();
  }

  function recordControlEvent(event) {
    const key =
      event.key || `control|${event.name || "Event"}|${event.tone || "active"}`;
    const lastEvent = state.events[state.events.length - 1];
    if (lastEvent?.key === key) {
      lastEvent.count = (lastEvent.count || 1) + 1;
      lastEvent.summary = event.summary || lastEvent.summary;
      lastEvent.updatedAt = Date.now();
    } else {
      state.events.push({
        key,
        count: event.count || 1,
        updatedAt: Date.now(),
        type: event.type || "control",
        name: event.name || "Event",
        tone: event.tone || "active",
        summary: event.summary || "",
      });
    }
    if (state.events.length > 1_200) {
      state.events.splice(0, state.events.length - 1_200);
    }
    if (event.tone === "failed") {
      shell.showToast(
        event.summary || event.name || "Operation failed",
        "failed",
      );
    }
  }

  function settleTerminal(message, requestId) {
    if (!isMatchingActiveRequest(state.activeRequestId, requestId)) return;
    const environmentId =
      textOf(message.environment || message.environmentId) ||
      selectedEnvironmentId();
    const sessionId = textOf(message.sessionId) || state.currentSessionId;
    state.activeRequestId = "";
    updateComposerSendState();
    void drainQueuedComposerMessage({
      environmentId,
      sessionId,
      terminalRequestId: requestId,
    });
  }

  function handle(rawMessage) {
    const message = normalizeRealtimeMessage(rawMessage);
    if (message.type === "steer_ack" && handleSteerAcknowledgement(message))
      return;
    if (!shouldAcceptMessage(message)) return;
    if (message.type === "chat_read_state") {
      applySessionReadState(message.sessionId, message.readState || message);
      return;
    }
    if (message.type === "token") {
      const requestId = textOf(message.requestId) || state.activeRequestId;
      if (!requestId) return;
      const assistant = activeAssistantForRequest(requestId);
      trackSeq(message);
      assistant.text += textOf(message.text ?? message.delta);
      assistant.streaming = true;
      scheduleMessageRender();
      return;
    }
    if (message.type === "chat_message") {
      addOrMergeMessage(normalizeChatMessage(message));
      renderMessages();
      if (textOf(message.sessionId) === state.currentSessionId) {
        markCurrentSessionReadSoon();
      }
      return;
    }
    if (message.type === "event") {
      const eventName = textOf(message.name);
      const requestId = textOf(message.requestId) || state.activeRequestId;
      if (eventName === "session.title.updated") {
        applySessionTitleUpdate(message.sessionId, message.title);
        return;
      }
      if (eventName === "thinking.delta" && requestId) {
        const assistant = activeAssistantForRequest(requestId);
        const incoming = textOf(message.text);
        const delta = textOf(message.delta);
        trackSeq(message);
        assistant.thinkingText =
          incoming || `${assistant.thinkingText || ""}${delta}`;
        assistant.streaming = true;
        scheduleThinkingRender();
        return;
      }
      if (eventName === "token" && requestId) {
        const assistant = activeAssistantForRequest(requestId);
        trackSeq(message);
        assistant.text += textOf(message.text ?? message.delta);
        assistant.streaming = true;
        scheduleMessageRender();
        return;
      }
    }
    if (message.type === "completed") {
      const terminalRequestId = textOf(message.requestId);
      const requestId = terminalRequestId || state.activeRequestId;
      if (requestId) {
        const assistant = activeAssistantForRequest(requestId);
        assistant.streaming = false;
        if (message.output) assistant.text = textOf(message.output);
        forgetThinkingDisclosure(assistant.id);
      }
      cancelScheduledMessageRender();
      recordEvent(message);
      cancelScheduledThinkingRender();
      renderMessages();
      setMessageActivityStatus("ABot response completed.");
      markCurrentSessionReadSoon();
      settleTerminal(message, terminalRequestId);
      void loadSessions();
      return;
    }
    if (message.type === "failed") {
      cancelScheduledMessageRender();
      const terminalRequestId = textOf(message.requestId);
      const requestId = terminalRequestId || state.activeRequestId;
      if (requestId) {
        const assistant = activeAssistantForRequest(requestId);
        assistant.streaming = false;
        assistant.text = textOf(message.error, "Request failed.");
        forgetThinkingDisclosure(assistant.id);
      }
      recordEvent(message);
      cancelScheduledThinkingRender();
      renderMessages();
      setMessageActivityStatus("ABot request failed.");
      settleTerminal(message, terminalRequestId);
      return;
    }
    recordEvent(message);
  }

  return { handle, recordControlEvent, recordEvent, trackSeq };
}
