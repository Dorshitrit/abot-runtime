import { canChooseReasoningBudget, isReasoningPreference } from "./lib/reasoning-preference.js";
import { createConversationReasoningPreferences } from "./services/conversation-reasoning-preferences.js";
import { canChooseReasoning } from "./lib/reasoning-controls.js";
import { createComposerFeature } from "./controllers/composer-feature.js";
import { createComposerDrafts } from "./controllers/composer-drafts.js";
import { createComposerDraftView } from "./controllers/composer-draft-view.js";
import { workspaceQueue, workspaceStorage } from "./services/workspace-state.js";
import { createAppState } from "./app-state.js";
import { createConversationViewFeature } from "./controllers/conversation-view-feature.js";
import { createConversationSessionController } from "./controllers/conversation-session-controller.js";
import { createRealtimeEventController } from "./controllers/realtime-event-controller.js";
import { createSteerController } from "./controllers/steer-controller.js";
import { createToolApprovalController } from "./controllers/tool-approval-controller.js";
import { createToolApprovalCard } from "./components/tool-approval-card.js";
import { createComposerActions } from "./components/composer-actions.js";
import { normalizeRealtimeMessage } from "./lib/realtime-message.js";
import { createSparkChatResults } from "./components/spark-chat/results.js";
import { sparkConversationMessages, sparkMessageStatus, sparkWorkingStatus } from "./lib/spark-chat-presentation.js";
import { createSparkChatEmptyState } from "./components/spark-chat/empty-state.js";
import { createSparkHandoffActions } from "./components/spark-chat/handoff-actions.js";
import { createSparkMascotActivity } from "./components/spark-chat/mascot-activity.js";

/** Separate view state, ordinary Runtime conversation mechanisms. */
export function createSparkChatConversation({
  dom, client, shell, getEnvironmentId, getConfiguration, isOpen, isConnected,
  getSubmissionBlock, scrollBehavior, refresh, onReadState, onRender,
  onOpenSchedule = () => {}, onOpenModelSettings = () => {},
  sendRealtime, onComposerStateChange = () => {}, sessionQueue = workspaceQueue(),
  captureHandoffNavigation, onHandoffOpened,
}) {
  const state = createAppState();
  const thinkingPreferences = createConversationReasoningPreferences(workspaceStorage());
  const drafts = createComposerDrafts();
  const draftView = createComposerDraftView({ input: dom.composerInput,
    getDraft: () => drafts.open({ environmentId: getEnvironmentId(), sessionId: state.currentSessionId }), isVisible: isOpen });
  drafts.subscribe(draftView.refresh);
  draftView.display();
  const mascotActivity = createSparkMascotActivity({ state, dom, isConnected });
  let session;
  let view;
  let realtime;
  let queue;
  let submit;
  let attachments;
  const status = (text, busy = false) => {
    dom.messagesList.setAttribute("aria-busy", String(busy));
    dom.messageStatusRegion.textContent = sparkMessageStatus(text);
  };
  const render = () => { view?.render(); mascotActivity.render(); onRender?.(); };
  const renderActivityStatus = () => { view?.renderActivityStatus(); mascotActivity.render(); };
  const updateSendState = () => { draftView.display(); submit?.updateSendState(); mascotActivity.render(); onComposerStateChange(state.composerSending); };
  const recordControlEvent = (event) => realtime?.recordControlEvent(event);
  const getToolPermissionMode = () => getConfiguration()?.toolPermissionMode || "ask";
  const getModelPreference = () => {
    const profileId = getConfiguration()?.modelProfileId;
    return profileId ? { profileId } : undefined;
  };
  const scope = () => ({ environmentId: getEnvironmentId(), sessionId: state.currentSessionId });
  const reasoningScope = () => ({ environmentId: getEnvironmentId(), sessionId: getConfiguration()?.sessionId || state.currentSessionId });
  function getReasoningPreference() {
    const profileId = getConfiguration()?.modelProfileId || "";
    const preference = thinkingPreferences.loadReasoningPreference(reasoningScope(), profileId);
    if (preference && !canChooseReasoningBudget(getConfiguration()))
      throw new Error("SPARK's model no longer supports this thinking override. Choose Profile default.");
    return preference;
  }
  const isScopeCurrent = (candidate) => candidate.environmentId === getEnvironmentId() && candidate.sessionId === state.currentSessionId;
  const steer = createSteerController({
    sendRealtime,
    getScope: () => ({ ...scope(), requestId: state.activeRequestId }),
    getPendingAttachmentCount: () => state.pendingAttachments.length,
    onAccepted: (message) => session.insertSteerMessage(message),
  });
  const actions = createComposerActions({ dom, onSendNext: () => submit.dispatch("send_next") });
  const approvals = createToolApprovalController({
    state, selectedEnvironmentId: getEnvironmentId, sendRealtime,
    renderMessages: render, recordControlEvent, createCard: createToolApprovalCard,
  });
  view = createConversationViewFeature({
    dom, filePreviewClient: client, getFileEnvironmentId: getEnvironmentId,
    getFileSessionId: () => state.currentSessionId,
    preserveMessageHistory: true,
    createActivityView: createSparkChatResults,
    statusPresentation: sparkWorkingStatus,
    statusPlacement: "outside",
    emptyState: createSparkChatEmptyState({ getConfiguration, onOpenModelSettings }),
    showReasoning: false,
    showContextWindow: false,
    getMessages: () => sparkConversationMessages(state.messages),
    getActiveRequestId: () => state.activeRequestId,
    isConnected,
    getActivityForMessage: (message) => ({
      events: state.events,
      taskProgress: state.taskProgressByRequest.get(message.requestId) || null,
      contextWindow: state.contextWindowByRequest.get(message.requestId) || null,
    }),
    getPendingApproval: approvals.pendingEvent, getPendingApprovals: approvals.pendingEvents,
    createApprovalCard: approvals.createCard,
    copyText: (text) => navigator.clipboard.writeText(text),
    notify: shell.showToast, resolveAttachmentUrl: (file) => attachments.previewUrl(file),
    onOpenSchedule, canOpenSchedule: () => client.supportsSchedules?.() === true,
    scrollBehavior,
    sparkActions: createSparkHandoffActions({
      getScope: () => ({ ...scope(), viewVersion: state.sessionViewVersion }), getMessages: () => state.messages,
      client, captureNavigation: captureHandoffNavigation, onOpened: onHandoffOpened,
      onChange: render, notify: shell.showToast,
    }),
  });
  // The popup never mutates ordinary conversation selection or browser preferences.
  const sessionClient = {
    ...client,
    async listSessions() { void refresh(); return { sessions: [] }; },
  };
  session = createConversationSessionController({
    state, dom: { ...dom, sessionTitle: document.createElement("span") },
    client: sessionClient,
    preferences: { saveSessionIdForEnvironment() {}, sessionIdForEnvironment: () => state.currentSessionId },
    sessions: {
      byId: () => ({ title: "ABot SPARK" }), titleOf: (value) => value.title,
      setCurrentTitle() {}, applyTitle() {}, applyReadState: (_id, readState) => onReadState(readState),
    },
    sessionQueue, conversationView: view, selectedEnvironmentId: getEnvironmentId,
    // Reading belongs to actual visible rows in the popup, never to session activation.
    isConversationVisible: () => false,
    applyConversationChrome() {}, applyModelSelection() {}, renderSessions() {},
    renderMessages: render, updateComposerSendState: updateSendState, setMessageStatus: status,
    sendRealtime, handleRealtimeMessage: (message) => realtime.handle(message),
    recordEvent: (message) => realtime.recordEvent(message), recordControlEvent,
    reportQueueFailure: (...args) => queue.reportFailure(...args),
    drainQueuedMessage: (...args) => queue.drain(...args),
    suspendQueueRecovery: (canNavigate) => queue.suspendRecoveryForNavigation(canNavigate),
    recoverBlockedQueue: (...args) => queue.recoverForManualSend(...args),
    isCurrentComposerScope: isScopeCurrent,
    createSessionId() { throw new Error("SPARK conversation is not ready yet."); },
  });
  const composer = createComposerFeature({
    state, dom: { ...dom, composerInput: draftView.surface }, shell, client, sessionQueue,
    drafts, getDraft: draftView.current, conversationSession: session, conversationView: view,
    getEnvironmentId, ensureSession: () => session.ensureSession(),
    getSettings: () => ({ agentMode: state.agentMode, toolPermissionMode: getToolPermissionMode(), modelPreference: getModelPreference(), reasoningPreference: getReasoningPreference() }),
    steer: steer.steer, composerActions: actions,
    selectedModelSupportsImageInput: () => getConfiguration()?.supportsImageInput === true,
    isComposerAvailable: () => !getSubmissionBlock(), getSubmissionBlock,
    onSubmissionBlocked: (block) => shell.showToast(block.message || "SPARK is not ready.", "failed"),
    isVisible: isOpen, renderSessions() {}, renderMessages: render, applyConversationChrome() {},
    setMessageStatus: status, recordControlEvent, onChange: () => onComposerStateChange(state.composerSending),
  });
  attachments = composer.attachments;
  queue = composer.queue;
  submit = composer.submit;
  realtime = createRealtimeEventController({
    state, shell, selectedEnvironmentId: getEnvironmentId,
    handleSteerAcknowledgement: steer.handleAcknowledgement,
    shouldAcceptMessage: session.shouldAcceptRealtimeMessage,
    applySessionReadState: session.applySessionReadState,
    activeAssistantForRequest: session.activeAssistantForRequest,
    addOrMergeMessage: session.addOrMergeMessage, normalizeChatMessage: session.normalizeMessage,
    renderMessages: render, renderContextWindow: view.renderContextWindow,
    renderActivityStatus,
    scheduleMessageRender: view.scheduleMessageRender, scheduleThinkingRender: view.scheduleThinkingRender,
    cancelScheduledMessageRender: view.cancelScheduledMessageRender,
    cancelScheduledThinkingRender: view.cancelScheduledThinkingRender,
    markCurrentSessionReadSoon: () => scrollBehavior.scheduleRead(),
    applySessionTitleUpdate() {}, setMessageActivityStatus: status, updateComposerSendState: updateSendState,
    drainQueuedComposerMessage: queue.drain, loadSessions: refresh,
  });

  function handleRealtime(raw) {
    const message = normalizeRealtimeMessage(raw);
    const environment = message.environmentId || message.environment;
    if (environment && environment !== getEnvironmentId()) return;
    if (message.type === "steer_ack") { steer.handleAcknowledgement(message); return; }
    if (message.sessionId && message.sessionId !== state.currentSessionId) return;
    if (!state.currentSessionId) return;
    if (!message.sessionId && message.requestId && !session.requestBelongsToCurrentView(message.requestId)) return;
    state.connected = isConnected();
    realtime.handle(message);
  }
  function bind() {
    view.bind(); actions.bind();
    dom.composerForm.addEventListener("submit", (event) => { event.preventDefault(); submit.dispatch(); });
    dom.composerInput.addEventListener("input", () => { submit.resize(); updateSendState(); });
    dom.composerInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault(); submit.dispatch();
    });
    dom.attachmentButton.addEventListener("click", () => dom.attachmentInput.click());
    dom.attachmentInput.addEventListener("change", () => {
      const files = [...dom.attachmentInput.files]; dom.attachmentInput.value = "";
      void Promise.allSettled(files.map((file) => attachments.upload(file))).then((results) => {
        for (const result of results) if (result.status === "rejected") shell.showToast(result.reason.message, "failed");
      });
    });
    dom.composerInput.addEventListener("paste", (event) => {
      const files = [...(event.clipboardData?.files || [])];
      if (!files.length) return;
      event.preventDefault();
      for (const file of files) void attachments.upload(file).catch((error) => shell.showToast(error.message, "failed"));
    });
  }
  return {
    state, session, view, attachments, render, handleRealtime, bind, queue,
    getReasoningPreference: () => thinkingPreferences.loadReasoningPreference(reasoningScope(), getConfiguration()?.modelProfileId || ""),
    setReasoningPreference(preference) {
      const profileId = getConfiguration()?.modelProfileId || "";
      if (preference && (!canChooseReasoningBudget(getConfiguration()) || !isReasoningPreference(preference) || preference.profileId !== profileId))
        throw new Error("Select a thinking preference supported by SPARK's current model.");
      return thinkingPreferences.saveReasoningPreference(reasoningScope(), profileId, preference);
    },
    prepareEnvironmentChange: () => queue.prepareRecoveryForNavigation(),
    async setAgentMode(mode) {
      if (!canChooseReasoning(getConfiguration())) return;
      const selectedScope = reasoningScope();
      const profileId = getConfiguration()?.modelProfileId || "";
      const preference = thinkingPreferences.loadReasoningPreference(selectedScope, profileId);
      if (preference?.mode === "off") await thinkingPreferences.saveReasoningPreference(selectedScope, profileId, undefined);
      if (JSON.stringify(selectedScope) !== JSON.stringify(reasoningScope()) || profileId !== getConfiguration()?.modelProfileId) return;
      state.agentMode = mode;
    },
    update() {
      state.connected = isConnected();
      draftView.display(); composer.changed(); updateSendState(); renderActivityStatus();
      if (!state.messages.length) render();
    },
    clearResetDraftData(environmentId, sessionIds) {
      for (const sessionId of sessionIds) drafts.resetSessionData({ environmentId, sessionId });
      if (environmentId !== getEnvironmentId()) return;
      draftView.display(); composer.changed();
    },
    reset() {
      steer.rejectAll("SPARK environment changed.");
      draftView.saveDisplayed(); session.invalidateEnvironmentLoads(); session.clearCurrentSessionView();
      draftView.display();
    },
    status,
  };
}
