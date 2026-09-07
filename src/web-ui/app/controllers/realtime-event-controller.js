import { createScheduleRealtimeController } from "./schedule-realtime.js";
import { isMatchingActiveRequest } from "../ui-behavior.js";
import {
  eventKeyFor,
  eventTone,
  formatEventDetail,
  formatEventLabel,
  isLowValueActivityEvent,
} from "../lib/event-presentation.js";
import { textOf } from "../lib/text-format.js";
import { normalizeRealtimeMessage } from "../lib/realtime-message.js";
import { reduceTaskProgress } from "../lib/task-progress.js";
import { projectWebSourceEvent } from "../lib/web-source-event.js";
import { projectToolActivityEvent } from "../lib/tool-activity-event.js";
import { canReplaceContextWindowEvidence } from "../lib/context-window-snapshot-order.js";

export { normalizeRealtimeMessage } from "../lib/realtime-message.js";
export { taskStatusClass } from "../lib/task-progress.js";

function hasOriginalEventSequence(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function hasRecordedOriginalEvent(events, requestId, eventSequence) {
  if (eventSequence === undefined) return false;
  return events.some(
    (event) =>
      event.requestId === requestId && event.eventSequence === eventSequence,
  );
}

function canMergeUnsequencedActivity(
  previous,
  key,
  eventSequence,
  webSources,
  toolActivity,
) {
  if (eventSequence !== undefined) return false;
  if (webSources || previous?.webSources) return false;
  if (toolActivity || previous?.toolActivity) return false;
  if (!previous?.key || previous.key !== key) return false;
  return !hasOriginalEventSequence(previous.eventSequence);
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
  renderContextWindow = () => {},
  renderActivityStatus = () => {},
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
  const scheduleRealtime = createScheduleRealtimeController({
    state,
    selectedEnvironmentId,
    addOrMergeMessage,
    normalizeChatMessage,
    activeAssistantForRequest,
    renderMessages,
    updateComposerSendState,
    setMessageActivityStatus,
    trackSeq,
    loadSessions,
  });

  function trackSeq(message) {
    if (message.requestId && typeof message.seqNo === "number") {
      state.lastSeqByRequest.set(message.requestId, message.seqNo);
    }
  }

  function updateTaskProgress(message) {
    const requestId = textOf(message.requestId);
    const current = state.taskProgressByRequest.get(requestId);
    const next = reduceTaskProgress(current, message);
    if (next && next !== current)
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
      lastCompactionEvent: null,
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
      if (!canReplaceContextWindowEvidence(previous, message)) return;
      const snapshot = {
        requestId,
        eventSequence: message.eventSequence,
        seqNo: message.seqNo,
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
      return true;
    }
    if (eventName === "context.window.provider_usage") {
      if (!canReplaceContextWindowEvidence(current.providerUsage, message))
        return;
      state.contextWindowByRequest.set(requestId, {
        ...current,
        requestId,
        providerUsage: {
          eventSequence: message.eventSequence,
          seqNo: message.seqNo,
          invocationId: textOf(message.invocationId),
          modelStep: textOf(message.modelStep),
          profileId: textOf(message.profileId),
          source: textOf(message.source, "provider_reported"),
          inputTokens: Number(message.inputTokens),
          outputTokens: Number(message.outputTokens),
          totalTokens: Number(message.totalTokens),
        },
      });
      return true;
    }
    if (eventName === "context.compaction.started") {
      if (
        !canReplaceContextWindowEvidence(current.lastCompactionEvent, message)
      )
        return;
      if (!canReplaceContextWindowEvidence(current.snapshot, message)) return;
      state.contextWindowByRequest.set(requestId, {
        ...current,
        requestId,
        lastCompactionEvent: {
          eventSequence: message.eventSequence,
          seqNo: message.seqNo,
        },
        pendingCompaction: {
          beforePercent: Number.isFinite(
            Number(message.beforeUsedContextPercent),
          )
            ? Number(message.beforeUsedContextPercent)
            : current.snapshot?.usedContextPercent,
        },
      });
      return true;
    }
    if (eventName === "context.compaction.completed") {
      if (
        !canReplaceContextWindowEvidence(current.lastCompactionEvent, message)
      )
        return;
      const beforePercent = Number(message.beforeUsedContextPercent);
      const afterPercent = Number(message.afterUsedContextPercent);
      state.contextWindowByRequest.set(requestId, {
        ...current,
        requestId,
        lastCompactionEvent: {
          eventSequence: message.eventSequence,
          seqNo: message.seqNo,
        },
        pendingCompaction: null,
        lastCompaction:
          Number.isFinite(beforePercent) && Number.isFinite(afterPercent)
            ? { beforePercent, afterPercent }
            : current.lastCompaction,
      });
      return true;
    }
    if (eventName === "context.compaction.failed") {
      if (
        !canReplaceContextWindowEvidence(current.lastCompactionEvent, message)
      )
        return;
      state.contextWindowByRequest.set(requestId, {
        ...current,
        requestId,
        lastCompactionEvent: {
          eventSequence: message.eventSequence,
          seqNo: message.seqNo,
        },
        pendingCompaction: null,
      });
      return true;
    }
  }

  function recordEvent(message) {
    const requestId = textOf(message.requestId) || state.activeRequestId;
    const eventSequence = hasOriginalEventSequence(message.eventSequence)
      ? message.eventSequence
      : undefined;
    if (hasRecordedOriginalEvent(state.events, requestId, eventSequence)) {
      trackSeq(message);
      return;
    }
    updateTaskProgress(message);
    const contextWindowUpdated = updateContextWindow(message);
    if (contextWindowUpdated) {
      renderContextWindow();
      renderActivityStatus();
    }
    const eventName = textOf(message.name || message.rawType || message.type);
    if (isLowValueActivityEvent(message)) {
      trackSeq(message);
      return;
    }
    const name = formatEventLabel(message);
    const summary = formatEventDetail(message);
    const tone = eventTone(message);
    const stage = textOf(message.stage);
    const phase = textOf(message.phase);
    const key = eventKeyFor({ ...message, requestId }, name, tone);
    const webSources = projectWebSourceEvent(message);
    const toolActivity = projectToolActivityEvent(message);
    const lastEvent = state.events[state.events.length - 1];
    if (
      canMergeUnsequencedActivity(
        lastEvent,
        key,
        eventSequence,
        webSources,
        toolActivity,
      )
    ) {
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
        eventSequence,
        updatedAt: Date.now(),
        type: message.type,
        rawType: message.rawType,
        eventName,
        stage,
        phase,
        name,
        summary,
        tone,
        tool: textOf(message.tool),
        approvalId: textOf(message.approvalId),
        ...(webSources ? { webSources } : {}),
        ...(toolActivity ? { toolActivity } : {}),
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
    renderActivityStatus();
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
    if (scheduleRealtime.handle(message)) return;
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
      renderActivityStatus();
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
