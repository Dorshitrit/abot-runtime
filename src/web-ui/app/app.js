import { captureComposerSubmissionScope, isCurrentComposerSubmissionScope } from "./lib/composer-submission-scope.js";
import { createComposerSurfaceController } from "./controllers/composer-surface-controller.js";
import { bootstrapWebApp } from "./app-bootstrap.js";
import { createConfigurationFeature } from "./configuration-feature.js";
import { createDashboardFeature } from "./dashboard-feature.js";
import { createComposerWorkspaceController } from "./controllers/composer-workspace-controller.js";
import { createHomeComposerFeature } from "./controllers/home-composer-feature.js";
import { createHomeConversationActivation } from "./controllers/home-conversation-activation.js";
import { findAppDom } from "./app-dom.js";
import { createSchedulesFeature } from "./schedules-feature.js";
import { createWorkspaceShell } from "./components/workspace-shell.js";
import { createComposerActions } from "./components/composer-actions.js";
import { createModelSelector } from "./components/model-selector.js";
import { createRuntimeSetupGuide } from "./components/runtime-setup-guide.js";
import { createSessionActionsMenu } from "./components/session-actions-menu.js";
import { createToolApprovalCard } from "./components/tool-approval-card.js";
import { textOf } from "./lib/text-format.js";
import { createConversationView } from "./components/conversation-view.js";
import { createSessionComposerQueue } from "./lib/session-composer-queue.js";
import { createRuntimeWebClient } from "./services/runtime-web-client.js";
import { createClientPreferences } from "./services/client-preferences.js";
import { createOperationsController } from "./controllers/operations-controller.js";
import { createRealtimeTransport } from "./services/realtime-transport.js";
import { createSteerController } from "./controllers/steer-controller.js";
import { createSessionController } from "./controllers/session-controller.js";
import { createComposerAttachmentsController } from "./controllers/composer-attachments-controller.js";
import { createComposerQueueController } from "./controllers/composer-queue-controller.js";
import { createRealtimeEventController } from "./controllers/realtime-event-controller.js";
import { createRuntimeSelectionController } from "./controllers/runtime-selection-controller.js";
import { createRuntimeOnboardingController } from "./controllers/runtime-onboarding-controller.js";
import { createAppEventBindings } from "./controllers/app-event-bindings.js";
import { createConversationSessionController } from "./controllers/conversation-session-controller.js";
import { createChatRequestController } from "./controllers/chat-request-controller.js";
import { createToolApprovalController } from "./controllers/tool-approval-controller.js";
import { createComposerSubmitController } from "./controllers/composer-submit-controller.js";

const state = {
  config: null,
  connected: false,
  sessions: [],
  pinnedSessionIds: [],
  sessionModes: {},
  sessionModels: {},
  lastModelByEnvironment: {},
  agentMode: "reasoning",
  supportedAgentModes: ["fast", "reasoning", "deep", "auto"],
  agentModeMenuOpen: false,
  permissionModeMenuOpen: false,
  agentPickerOpen: false,
  busySessionIds: new Set(),
  messages: [],
  events: [],
  taskProgressByRequest: new Map(),
  contextWindowByRequest: new Map(),
  submittedToolApprovalIds: new Set(),
  requestMessages: new Map(),
  currentSessionId: "",
  activeRequestId: "",
  sessionViewVersion: 0,
  lastSeqByRequest: new Map(),
  modelProfiles: [],
  defaultModelProfileId: "",
  runtimeAvailability: { status: "loading" },
  pendingAttachments: [],
  pendingAttachmentUploadCounts: new Map(),
  composerAttachmentGeneration: 0,
  composerSending: false,
  composerQueueDrainingScopes: new Set(),
  composerQueueRecoveredReleaseTokens: new Set(),
  activeComposerQueueRecovery: null,
  sessionQuery: "",
};

const dom = findAppDom();

const preferences = createClientPreferences(localStorage);
const runtimeClient = createRuntimeWebClient({
  getConfig: () => state.config,
  getEnvironmentId: selectedEnvironmentId,
});
let conversationSession;
let chatRequests;
let composerQueueController;
let composerSubmitController;
let realtimeEvents;
let conversationView;
let configWorkspace;
let schedulesFeature;
let dashboardFeature;
let homeComposer;
let runtimeSelection;
const operationsController = createOperationsController({
  dom,
  client: runtimeClient,
});
const realtimeTransport = createRealtimeTransport({
  getConfig: () => state.config,
  onMessage: handleRealtimeMessage,
  onOpen: () => {
    state.connected = true;
    setConnectionLabel("Connected");
    if (state.currentSessionId) subscribeSession(state.currentSessionId);
  },
  onClose: () => {
    state.connected = false;
    rejectPendingSteers(
      "Realtime connection closed before steer was accepted.",
    );
    setConnectionLabel("Reconnecting", true);
  },
  onError: () => {
    state.connected = false;
    setConnectionLabel("Connection issue", true);
  },
  onParseError: (error, preview) => {
    recordControlEvent({
      type: "control",
      name: "Realtime parse error",
      tone: "failed",
      summary: `${error instanceof Error ? error.message : String(error)}${
        preview ? `: ${preview}` : ""
      }`,
    });
  },
});
const steerController = createSteerController({
  sendRealtime,
  getScope: () => ({
    requestId: state.activeRequestId,
    environmentId: selectedEnvironmentId(),
    sessionId: state.currentSessionId,
  }),
  getPendingAttachmentCount: () => state.pendingAttachments.length,
  onAccepted: (message) => conversationSession.insertSteerMessage(message),
});

const shell = createWorkspaceShell({
  dom,
  isWorkspaceAvailable: (destination) =>
    schedulesFeature?.isWorkspaceAvailable(destination) ?? false,
  onWorkspaceChange: (workspace) => {
    runtimeSelection?.rememberModelSelection();
    homeComposer?.setWorkspace(workspace);
    schedulesFeature?.setActive(workspace === "schedules");
    dashboardFeature?.setActive(workspace === "home");
    runtimeSelection?.applyModelSelection();
    runtimeSelection?.renderPermissionMode();
    renderAttachmentComposer();
    updateComposerSendState();
    conversationSession?.markCurrentSessionReadSoon();
  },
  beforeWorkspaceChange: ({ from, to }) => {
    if (from === "schedules" && to !== "schedules")
      return schedulesFeature?.prepareLeave() ?? true;
    if (from !== "config" || to === "config") return true;
    if (!configWorkspace) return true;
    return configWorkspace.prepareDiscardChanges("leave configuration");
  },
});
const runtimeSetupGuide = createRuntimeSetupGuide({
  container: dom.runtimeSetupGuide,
  conversationRegion: dom.messagesList,
  copyText: (value) => navigator.clipboard.writeText(value),
  getSetupCommandMode: () => state.config?.setupCommandMode,
});
const runtimeOnboarding = createRuntimeOnboardingController({
  state,
  guide: runtimeSetupGuide,
  reloadModels: loadModels,
  setMessageStatus: setMessageActivityStatus,
  onStateChange: () => {
    updateComposerSendState();
    renderAttachmentComposer();
    dashboardFeature?.publish();
  },
});

const composerActions = createComposerActions({
  dom,
  onSendNext: () => dispatchComposerMessage("send_next"),
});
schedulesFeature = createSchedulesFeature({
  dom,
  client: runtimeClient,
  shell,
  selectedEnvironmentId,
  getCurrentSessionId: () => state.currentSessionId,
  getAgentModes: () => state.supportedAgentModes,
  openSession: (sessionId) => conversationSession.openSession(sessionId),
});
dashboardFeature = createDashboardFeature({
  dom,
  state,
  client: runtimeClient,
  shell,
  schedules: schedulesFeature,
  selectedEnvironmentId,
  loadSessions,
  openSession: (sessionId) => conversationSession.openSession(sessionId),
  isComposerAvailable: runtimeOnboarding.isReady,
});
const composerWorkspace = createComposerWorkspaceController({
  state,
  dom,
  homeComposerHost: dashboardFeature.composerHost,
  selectedEnvironmentId,
  homeSetupHost: dashboardFeature.setupHost,
});
const {
  renderAttachmentComposer,
  removeUnsupportedPendingImages,
  updateComposerSendState,
  uploadComposerAttachment,
  resizeComposerInput,
  dispatchComposerMessage,
} = createComposerSurfaceController({
  workspace: composerWorkspace,
  getHomeComposer: () => homeComposer,
  getChatAttachments: () => composerAttachments,
  getChatSubmit: () => composerSubmitController,
  rememberModelSelection: rememberCurrentModelSelection,
  showToast: shell.showToast,
});
const sessionComposerQueue = createSessionComposerQueue({
  storage: localStorage,
});
const sessionActionsMenu = createSessionActionsMenu({
  container: dom.sessionsList,
});
const sessionController = createSessionController({
  state,
  dom,
  sessionActionsMenu,
  shell,
  preferences,
  client: runtimeClient,
  selectedEnvironmentId,
  onOpen: (sessionId) => conversationSession.openSession(sessionId),
  onClearCurrent: (resetSession) => {
    if (resetSession) {
      conversationSession.clearCurrentSessionView();
      return;
    }
    conversationSession.clearSessionMessagesView();
  },
  onClearSessionMode: clearSessionMode,
  onSaveModelPreferences: saveModelPreferences,
  onReload: () => conversationSession.loadSessions(),
  onControlEvent: recordControlEvent,
});
const composerAttachments = createComposerAttachmentsController({
  state,
  dom,
  shell,
  client: runtimeClient,
  selectedEnvironmentId,
  selectedModelSupportsImageInput: () =>
    runtimeSelection.selectedModelSupportsImageInput(
      composerWorkspace.isChatVisible()
        ? dom.modelSelect.value
        : state.sessionModels[state.currentSessionId] ||
            state.defaultModelProfileId,
    ),
  ensureSession: () => conversationSession.ensureSession(),
  onSendStateChange: updateComposerSendState,
  onControlEvent: recordControlEvent,
  isComposerAvailable: runtimeOnboarding.isReady,
  isComposerVisible: composerWorkspace.isChatVisible,
});
const toolApprovalController = createToolApprovalController({
  state,
  selectedEnvironmentId,
  sendRealtime,
  renderMessages,
  recordControlEvent,
  createCard: createToolApprovalCard,
});
conversationView = createConversationView({
  dom: {
    messagesList: dom.messagesList,
    jumpToLatestButton: dom.jumpToLatestButton,
    composerContextWindow: dom.composerContextWindow,
    composerPlan: dom.composerPlan,
  },
  getMessages: () => state.messages,
  getActiveRequestId: () => state.activeRequestId,
  isConnected: () => state.connected,
  getActivityForMessage: (message) => ({
    events: state.events,
    taskProgress:
      state.taskProgressByRequest.get(textOf(message.requestId)) || null,
    contextWindow:
      state.contextWindowByRequest.get(textOf(message.requestId)) || null,
  }),
  getPendingApproval: toolApprovalController.pendingEvent,
  createApprovalCard: toolApprovalController.createCard,
  copyText: (text) => navigator.clipboard.writeText(text),
  notify: (message, tone) => shell.showToast(message, tone),
  resolveAttachmentUrl: attachmentPreviewUrl,
  onOpenSchedule: (jobId) => schedulesFeature.openJob(jobId),
  canOpenSchedule: runtimeClient.supportsSchedules,
});
conversationSession = createConversationSessionController({
  state,
  dom,
  client: runtimeClient,
  preferences,
  sessions: sessionController,
  sessionQueue: sessionComposerQueue,
  conversationView,
  selectedEnvironmentId,
  isConversationVisible: () =>
    shell.activeWorkspace() === "chat" &&
    !dom.chatPanel.inert &&
    document.visibilityState === "visible",
  onSessionListState: dashboardFeature.sessionsChanged,
  clearPendingAttachments,
  applyConversationChrome: applyConversationModeChrome,
  applyModelSelection: applyModelSelectionForCurrentSession,
  renderSessions,
  renderMessages,
  updateComposerSendState,
  setMessageStatus: setMessageActivityStatus,
  sendRealtime,
  handleRealtimeMessage,
  recordEvent,
  recordControlEvent,
  reportQueueFailure: (scope, summary) =>
    composerQueueController.reportFailure(scope, summary),
  drainQueuedMessage: (input) => composerQueueController.drain(input),
  suspendQueueRecovery: () =>
    composerQueueController.suspendRecoveryForNavigation(),
  recoverBlockedQueue: (scope) =>
    composerQueueController.recoverForManualSend(scope),
  isCurrentComposerScope: (scope) =>
    composerQueueController.isCurrentScope(scope),
});
chatRequests = createChatRequestController({
  state,
  client: runtimeClient,
  sessionQueue: sessionComposerQueue,
  conversationView,
  conversationSession,
  attachments: composerAttachments,
  currentComposerScope: () => composerQueueController.currentScope(),
  isCurrentComposerScope: (scope) =>
    composerQueueController.isCurrentScope(scope),
  rememberModelSelection: rememberCurrentModelSelection,
  applyConversationChrome: applyConversationModeChrome,
  renderSessions,
  renderAttachments: renderAttachmentComposer,
  getToolPermissionMode: currentToolPermissionMode,
  getModelPreference: selectedModelPreference,
  clearQueueRecovery: (scope) => composerQueueController.clearRecovery(scope),
  reportQueueFailure: (scope, summary) =>
    composerQueueController.reportFailure(scope, summary),
});
composerQueueController = createComposerQueueController({
  state,
  dom: composerWorkspace.chatDom,
  queue: sessionComposerQueue,
  selectedEnvironmentId,
  getToolPermissionMode: currentToolPermissionMode,
  getModelPreference: selectedModelPreference,
  rememberModelSelection: rememberCurrentModelSelection,
  attachments: composerAttachments,
  updateSendState: updateComposerSendState,
  postChatMessage: chatRequests.postChatMessage,
  appendLocalUserMessage: conversationSession.appendLocalUserMessage,
  activateRequestForScope: conversationSession.activateRequestForScope,
  renderMessages,
  setMessageStatus: setMessageActivityStatus,
  recordControlEvent,
  resizeComposer: resizeComposerInput,
});
composerSubmitController = createComposerSubmitController({
  state,
  dom: composerWorkspace.chatDom,
  composerActions,
  attachments: composerAttachments,
  queue: composerQueueController,
  steer: (text) => steerController.steer(text),
  chatRequests,
  conversationSession,
  selectedEnvironmentId,
  setMessageStatus: setMessageActivityStatus,
  getSubmissionBlock: runtimeOnboarding.submissionBlock,
  onSubmissionBlocked: runtimeOnboarding.presentSubmissionBlock,
  isComposerVisible: composerWorkspace.isChatVisible,
});
realtimeEvents = createRealtimeEventController({
  state,
  shell,
  selectedEnvironmentId,
  handleSteerAcknowledgement,
  shouldAcceptMessage: conversationSession.shouldAcceptRealtimeMessage,
  applySessionReadState: conversationSession.applySessionReadState,
  activeAssistantForRequest: conversationSession.activeAssistantForRequest,
  addOrMergeMessage: conversationSession.addOrMergeMessage,
  normalizeChatMessage: conversationSession.normalizeMessage,
  renderContextWindow: () => conversationView.renderContextWindow(),
  renderActivityStatus: () => conversationView.renderActivityStatus(),
  renderMessages,
  scheduleMessageRender,
  scheduleThinkingRender,
  cancelScheduledMessageRender,
  cancelScheduledThinkingRender,
  forgetThinkingDisclosure: (messageId) =>
    conversationView.forgetThinkingDisclosure(messageId),
  markCurrentSessionReadSoon: conversationSession.markCurrentSessionReadSoon,
  applySessionTitleUpdate: conversationSession.applySessionTitleUpdate,
  setMessageActivityStatus,
  updateComposerSendState,
  drainQueuedComposerMessage,
  loadSessions: conversationSession.loadSessions,
});

const modelSelector = createModelSelector({
  select: dom.modelSelect,
  button: dom.modelSelectButton,
  valueLabel: dom.modelSelectValue,
  menu: dom.modelSelectMenu,
  onOpen: () => {
    state.agentModeMenuOpen = false;
    state.permissionModeMenuOpen = false;
    renderAgentModeControl();
    renderPermissionModeControl();
  },
});
runtimeSelection = createRuntimeSelectionController({
  state,
  dom,
  preferences,
  modelSelector,
  client: runtimeClient,
  recordControlEvent,
  onAttachmentPolicyChange: renderAttachmentComposer,
  onModelCatalogLoading: runtimeOnboarding.beginCatalogLoad,
  onModelCatalogLoaded: runtimeOnboarding.applyCatalog,
  onModelCatalogUnavailable: runtimeOnboarding.catalogUnavailable,
  getComposerSessionId: composerWorkspace.composerSessionId,
});
homeComposer = createHomeComposerFeature({
  workspace: composerWorkspace,
  shell,
  client: runtimeClient,
  composerActions,
  selectedEnvironmentId,
  selectedModelSupportsImageInput: () =>
    runtimeSelection.selectedModelSupportsImageInput(
      composerWorkspace.isHome()
        ? dom.modelSelect.value
        : state.sessionModels[composerWorkspace.homeState.currentSessionId] ||
            state.defaultModelProfileId,
    ),
  isComposerAvailable: runtimeOnboarding.isReady,
  getSubmissionBlock: runtimeOnboarding.submissionBlock,
  onSubmissionBlocked: runtimeOnboarding.presentSubmissionBlock,
  onControlEvent: recordControlEvent,
  onStateChange: updateComposerSendState,
  activateHomeSession: createHomeConversationActivation({
    state,
    shell,
    conversationSession,
    composerQueue: composerQueueController,
    preferences,
    selectedEnvironmentId,
    renderSessions,
    renderMessages,
    applyModelSelection: applyModelSelectionForCurrentSession,
    setCurrentTitle: setCurrentSessionTitle,
    updateComposerSendState,
  }),
  sendMessage: async (text) => {
    const scope = captureComposerSubmissionScope(state, selectedEnvironmentId());
    state.composerSending = true;
    updateComposerSendState();
    try {
      await chatRequests.sendMessage(text);
    } catch (error) {
      if (!isCurrentComposerSubmissionScope(scope, state, selectedEnvironmentId())) return;
      conversationSession.appendRequestError(error);
    } finally {
      if (isCurrentComposerSubmissionScope(scope, state, selectedEnvironmentId())) {
        state.composerSending = false;
        updateComposerSendState();
      }
    }
  },
});
const appEventBindings = createAppEventBindings({
  state,
  dom,
  shell,
  modelSelector,
  composerActions,
  actions: {
    renderSessions,
    loadSessions,
    suspendQueueRecovery: suspendRecoveredComposerReleaseForNavigation,
    saveSessionId: saveSessionIdForEnvironment,
    selectedEnvironmentId,
    rememberModelSelection: rememberCurrentModelSelection,
    invalidateSessionLoads: conversationSession.invalidateEnvironmentLoads,
    clearAttachments: clearPendingAttachments,
    resetLiveRequestView: conversationSession.resetLiveRequestView,
    setCurrentSessionTitle,
    applyConversationChrome: applyConversationModeChrome,
    subscribeSession,
    renderMessages,
    renderAgentPicker,
    savedEnvironmentId,
    beforeEnvironmentChange: () => {
      if (!schedulesFeature.prepareLeave()) return false;
      return configWorkspace.prepareDiscardChanges("change environment");
    },
    saveEnvironmentId,
    loadModels,
    loadAgentMode,
    loadRuntimeConfig: (options) => loadRuntimeConfig(options),
    restoreLastSession,
    configuredEnvironmentOptions,
    removeUnsupportedImages: removeUnsupportedPendingImages,
    renderAttachments: renderAttachmentComposer,
    uploadAttachment: uploadComposerAttachment,
    renderAgentMode: renderAgentModeControl,
    renderPermissionMode: renderPermissionModeControl,
    dispatchComposerMessage,
    resizeComposer: resizeComposerInput,
    updateComposerSendState,
    loadRuntimeStatus,
    loadRuntimeLogs,
    loadSystemHealth,
  },
});

configWorkspace = createConfigurationFeature({
  dom,
  runtimeClient,
  selectedEnvironmentId,
  recordControlEvent,
});

const loadRuntimeConfig = (options) => configWorkspace.load(options);

function setConnectionLabel(text, isError = false) {
  dom.connectionLabel.textContent = text;
  dom.connectionLabel.title = `Runtime: ${text}`;
  dom.connectionLabel.classList.toggle("error-text", isError);
  dom.connectionLabel.classList.toggle(
    "connected",
    state.connected && !isError,
  );
  conversationView?.renderActivityStatus();
}

function configuredEnvironmentOptions() {
  return runtimeSelection.configuredEnvironmentOptions();
}

function selectedEnvironmentId() {
  return runtimeSelection?.selectedEnvironmentId() ?? "";
}

function renderAgentPicker() {
  runtimeSelection.renderAgentPicker();
}

function selectedModelPreference() {
  return runtimeSelection.selectedModelPreference();
}

function saveModelPreferences() {
  runtimeSelection.saveModelPreferences();
}

function setMessageActivityStatus(message, busy = false) {
  dom.messagesList.setAttribute("aria-busy", busy ? "true" : "false");
  dom.messageStatusRegion.textContent = textOf(message);
}

function applyModelSelectionForCurrentSession() {
  runtimeSelection.applyModelSelection();
}

function rememberCurrentModelSelection() {
  runtimeSelection.rememberModelSelection();
}

function currentToolPermissionMode() {
  return runtimeSelection.currentToolPermissionMode();
}

function clearSessionMode(sessionId) {
  runtimeSelection.clearSessionMode(sessionId);
}

function applyConversationModeChrome() {
  renderPermissionModeControl();
}

function renderPermissionModeControl() {
  runtimeSelection.renderPermissionMode();
}

function savedEnvironmentId() {
  return preferences.environmentId();
}

function saveEnvironmentId(environmentId) {
  preferences.saveEnvironmentId(environmentId);
}

function saveSessionIdForEnvironment(environmentId, sessionId) {
  preferences.saveSessionIdForEnvironment(environmentId, sessionId);
}

function setCurrentSessionTitle(title) {
  sessionController.setCurrentTitle(title);
}

function renderSessions() {
  sessionController.render();
  dashboardFeature?.publish();
}

function renderMessages() {
  conversationView.render();
}

function scheduleThinkingRender() {
  conversationView.scheduleThinkingRender();
}

function scheduleMessageRender() {
  conversationView.scheduleMessageRender();
}

function cancelScheduledMessageRender() {
  conversationView.cancelScheduledMessageRender();
}

function cancelScheduledThinkingRender() {
  conversationView.cancelScheduledThinkingRender();
}

function attachmentPreviewUrl(attachment) {
  return composerAttachments.previewUrl(attachment);
}

function clearPendingAttachments(options = {}) {
  composerAttachments.clear(options);
}

function renderAgentModeControl() {
  runtimeSelection.renderAgentMode();
}

async function loadAgentMode() {
  await runtimeSelection.loadAgentMode();
}

function recordEvent(message) {
  realtimeEvents.recordEvent(message);
}

function recordControlEvent(event) {
  realtimeEvents.recordControlEvent(event);
}

function handleSteerAcknowledgement(message) {
  return steerController.handleAcknowledgement(message);
}

function rejectPendingSteers(reason) {
  steerController.rejectAll(reason);
}

function handleRealtimeMessage(message) {
  realtimeEvents.handle(message);
}

function sendRealtime(payload) {
  return realtimeTransport.send(payload);
}

function subscribeSession(sessionId) {
  conversationSession.subscribeSession(sessionId);
}

async function loadModels() {
  await runtimeSelection.loadModels();
}

async function loadSessions() {
  return conversationSession.loadSessions();
}

async function restoreLastSession() {
  return conversationSession.restoreLastSession();
}

async function drainQueuedComposerMessage({
  environmentId,
  sessionId,
  terminalRequestId,
}) {
  await composerQueueController.drain({
    environmentId,
    sessionId,
    terminalRequestId,
  });
}

async function loadRuntimeStatus() {
  await operationsController.loadRuntimeStatus();
}

async function loadRuntimeLogs() {
  await operationsController.loadRuntimeLogs();
}

async function loadSystemHealth() {
  await operationsController.loadSystemHealth();
}

function bindEvents() {
  appEventBindings.bind();
  document.addEventListener(
    "visibilitychange",
    conversationSession.markCurrentSessionReadSoon,
  );
  dom.environmentSelect.addEventListener("change", () => {
    homeComposer.environmentChanged();
    dashboardFeature.environmentChanged();
  });
}

function suspendRecoveredComposerReleaseForNavigation() {
  return composerQueueController.suspendRecoveryForNavigation();
}

void bootstrapWebApp({
  state,
  dom,
  preferences,
  shell,
  homeComposer,
  dashboard: dashboardFeature,
  schedules: schedulesFeature,
  selection: runtimeSelection,
  client: runtimeClient,
  bindables: [
    sessionActionsMenu,
    conversationView,
    configWorkspace,
    composerActions,
    modelSelector,
    runtimeOnboarding,
  ],
  bindEvents,
  renderComposer: () => {
    resizeComposerInput();
    updateComposerSendState();
  },
  renderMessages,
  operations: operationsController,
  configuration: configWorkspace,
  realtime: realtimeTransport,
  restoreLastSession,
}).catch((error) => {
  setConnectionLabel(
    error instanceof Error ? error.message : String(error),
    true,
  );
});
