import { isBlockedCompletion } from "../lib/completion-presentation.js";
import { recordedPresentationRole } from "../lib/role-presentation.js";
import { failureResponseText } from "../lib/failure-presentation.js";
import { isAcknowledgementPresentationEvent } from "../lib/conversation-work-timeline-model.js";
import { isUserInteractionEvent } from "../lib/user-interaction-event.js";
import { acceptsUserInteractionScope, applyUserInteractionEvent } from "../lib/request-interaction-messages.js";
import { createScheduleRealtimeController } from "./schedule-realtime.js";
import {
  isStopResult,
  stoppedResponseText,
} from "../lib/request-stop-state.js";
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
import {
  hasRecordedRoleDelegation,
  projectRoleDelegationEvent,
} from "../lib/role-delegation-event.js";
import {
  hasRecordedRoleReturn,
  projectRoleReturnEvent,
} from "../lib/role-return-event.js";
import {
  contextEvidenceScope,
  contextEvidenceOrder,
  reduceContextWindowEvidence,
  synchronizeContextRequestLifecycle,
} from "../lib/context-window-state.js";
import { isWorkspaceChange } from "../lib/workspace-change.js";
import { createRequestLifecycleController } from "./request-lifecycle-controller.js";
import { ownsToolApprovalAcknowledgement } from "../lib/tool-approval-acknowledgement.js";

export { normalizeRealtimeMessage } from "../lib/realtime-message.js";
export { taskStatusClass } from "../lib/task-progress.js";

function hasCurrentAcknowledgementScope(state, message, environmentId) {
  if (!isAcknowledgementPresentationEvent(message)) return true;
  return acceptsUserInteractionScope(state, message, environmentId);
}

function shouldOmitActivityEvent(message) {
  if (isAcknowledgementPresentationEvent(message)) return false;
  return isLowValueActivityEvent(message);
}

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
  incoming,
  key,
  eventSequence,
  webSources,
  toolActivity,
  roleDelegation,
  roleReturn,
) {
  if (isAcknowledgementPresentationEvent(previous)) return false;
  if (isAcknowledgementPresentationEvent(incoming)) return false;
  if (eventSequence !== undefined) return false;
  if (webSources || previous?.webSources) return false;
  if (toolActivity || previous?.toolActivity) return false;
  if (roleDelegation || previous?.roleDelegation) return false;
  if (roleReturn || previous?.roleReturn) return false;
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
  markCurrentSessionReadSoon,
  applySessionTitleUpdate,
  setMessageActivityStatus,
  updateComposerSendState,
  drainQueuedComposerMessage,
  loadSessions,
}) {
  const lifecycleController = createRequestLifecycleController({
    state,
    onAcceptedLifecycle: (message) =>
      synchronizeContextRequestLifecycle(
        state,
        message,
        selectedEnvironmentId(),
      ),
    addOrMergeMessage,
    normalizeChatMessage,
    activeAssistantForRequest,
    updateComposerSendState,
    renderMessages,
    setMessageActivityStatus,
    markCurrentSessionReadSoon,
    cancelScheduledMessageRender,
    cancelScheduledThinkingRender,
  });
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
      state.lastSeqByRequest.set(
        message.requestId,
        Math.max(
          state.lastSeqByRequest.get(message.requestId) || 0,
          message.seqNo,
        ),
      );
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
    const requestId = textOf(message.requestId);
    const current = state.contextWindowByRequest.get(requestId);
    const scope = contextEvidenceScope(
      state,
      selectedEnvironmentId(),
      requestId,
    );
    const next = reduceContextWindowEvidence(current, message, scope);
    if (!next || next === current) return false;
    state.contextWindowByRequest.set(requestId, next);
    return true;
  }

  function recordEvent(message) {
    if (!hasCurrentAcknowledgementScope(state, message, selectedEnvironmentId())) return;
    if (isUserInteractionEvent(message)) {
      if (!acceptsUserInteractionScope(state, message, selectedEnvironmentId())) return;
      const changed = applyUserInteractionEvent(state, message, selectedEnvironmentId());
      trackSeq(message);
      if (changed) scheduleMessageRender();
      return;
    }
    if (isWorkspaceChange(message)) {
      trackSeq(message);
      return;
    }
    const requestId = textOf(message.requestId) || state.activeRequestId;
    const eventSequence = hasOriginalEventSequence(message.eventSequence)
      ? message.eventSequence
      : undefined;
    const contextWindowUpdated = updateContextWindow(message);
    if (contextWindowUpdated) {
      renderContextWindow();
      renderActivityStatus();
    }
    const roleDelegation = projectRoleDelegationEvent(message);
    const roleReturn = projectRoleReturnEvent(message);
    let alreadyRecorded = hasRecordedOriginalEvent(state.events, requestId, eventSequence);
    if (roleDelegation) alreadyRecorded = hasRecordedRoleDelegation(state.events, roleDelegation);
    if (roleReturn) alreadyRecorded = hasRecordedRoleReturn(state.events, roleReturn);
    if (alreadyRecorded) {
      trackSeq(message);
      return;
    }
    updateTaskProgress(message);
    const eventName = textOf(message.name || message.rawType || message.type);
    if (shouldOmitActivityEvent(message)) {
      trackSeq(message);
      return;
    }
    const name = formatEventLabel(message);
    const summary = formatEventDetail(message);
    const tone = eventTone(message);
    const stage = textOf(message.stage);
    const presentationRole = recordedPresentationRole(message.executorRole || stage, message.presentationRole);
    const phase = textOf(message.phase);
    const key = eventKeyFor({ ...message, requestId }, name, tone);
    const webSources = projectWebSourceEvent(message);
    const toolActivity = projectToolActivityEvent(message);
    const contextOrder = contextEvidenceOrder(
      message,
      contextEvidenceScope(state, selectedEnvironmentId(), requestId),
    );
    const lastEvent = state.events[state.events.length - 1];
    if (
      canMergeUnsequencedActivity(
        lastEvent,
        message,
        key,
        eventSequence,
        webSources,
        toolActivity,
        roleDelegation,
        roleReturn,
      )
    ) {
      lastEvent.count = (lastEvent.count || 1) + 1;
      lastEvent.summary = summary;
      lastEvent.updatedAt = Date.now();
      Object.assign(lastEvent, contextOrder);
      if (presentationRole) lastEvent.presentationRole = presentationRole;
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
        generation: textOf(message.generation),
        ...(isAcknowledgementPresentationEvent(message)
          ? { presentationKind: "acknowledgement", text: textOf(message.text || message.delta) } : {}),
        ...contextOrder,
        updatedAt: Date.now(),
        type: message.type,
        ...(isBlockedCompletion(message) ? { disposition: "blocked" } : {}),
        rawType: message.rawType,
        eventName,
        stage,
        ...(presentationRole ? { presentationRole } : {}),
        phase,
        name,
        summary,
        tone,
        tool: textOf(message.tool),
        approvalId: textOf(message.approvalId),
        recommendedToolPermissionMode: textOf(
          message.recommendedToolPermissionMode,
        ),
        ...(webSources ? { webSources } : {}),
        ...(toolActivity ? { toolActivity } : {}),
        ...(roleDelegation ? { roleDelegation } : {}),
        ...(roleReturn ? { roleReturn } : {}),
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
      cancelled: isStopResult(message),
    });
  }

  function handle(rawMessage) {
    const message = normalizeRealtimeMessage(rawMessage);
    if (message.type === "tool_approval_ack") {
      if (
        !ownsToolApprovalAcknowledgement(
          message,
          state,
          selectedEnvironmentId(),
        )
      )
        return;
      if (!message.accepted) {
        state.submittedToolApprovalIds.delete(message.approvalId);
        recordControlEvent({
          name: "Approval unavailable",
          tone: "failed",
          summary:
            "The decision could not be saved. Refresh the conversation and try again.",
        });
        renderMessages();
      }
      return;
    }
    if (message.type === "steer_ack" && handleSteerAcknowledgement(message))
      return;
    if (scheduleRealtime.handle(message)) return;
    if (!shouldAcceptMessage(message)) return;
    if (lifecycleController.handle(message)) {
      recordEvent(message);
      return;
    }
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
      if (isAcknowledgementPresentationEvent(message)) {
        recordEvent(message);
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
      }
      cancelScheduledMessageRender();
      recordEvent(message);
      renderActivityStatus();
      cancelScheduledThinkingRender();
      renderMessages();
      setMessageActivityStatus(isBlockedCompletion(message) ? "ABot request blocked." : "ABot response completed.");
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
        assistant.text = isStopResult(message)
          ? stoppedResponseText(assistant.text, message)
          : failureResponseText(message);
      }
      recordEvent(message);
      cancelScheduledThinkingRender();
      renderMessages();
      setMessageActivityStatus(
        isStopResult(message) ? "Response stopped." : "ABot request failed.",
      );
      settleTerminal(message, terminalRequestId);
      return;
    }
    recordEvent(message);
  }

  return { handle, recordControlEvent, recordEvent, trackSeq };
}
