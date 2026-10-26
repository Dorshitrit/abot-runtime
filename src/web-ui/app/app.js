import { createAppearanceFeature } from "./appearance-feature.js";
import { createStepTimeoutFeature } from "./step-timeout-feature.js";
import { createComposerFeature } from "./controllers/composer-feature.js";
import { isWorkspaceChange } from "./lib/workspace-change.js";
import { prepareEnvironmentWorkspaceChanges } from "./controllers/environment-workspace-preparation.js";
import { createAppState } from "./app-state.js";
import { createInformationBasketFeature } from "./information-basket-feature.js";
import { createSkillsFeature } from "./skills-feature.js";
import { createProjectsFeature } from "./projects-feature.js";
import { createComposerSurfaceController } from "./controllers/composer-surface-controller.js";
import { startWebApp } from "./app-bootstrap.js";
import { createNotificationsFeature } from "./notifications-feature.js";
import { bindWebAppWorkspaceLifecycle } from "./app-page-bindings.js";
import { createConfigurationFeature } from "./configuration-environment-refresh.js";
import { isConfigurationWorkspace } from "./lib/configuration-pages.js";
import { createDashboardFeature } from "./dashboard-feature.js";
import { createPassiveLearningFeature } from "./passive-learning-feature.js";
import { createComposerWorkspaceController } from "./controllers/composer-workspace-controller.js";
import { createHomeComposerFeature } from "./controllers/home-composer-feature.js";
import { createHomeConversationActivation } from "./controllers/home-conversation-activation.js";
import { findAppDom } from "./app-dom.js";
import { createSchedulesFeature } from "./schedules-feature.js";
import { createWorkspaceShell } from "./components/workspace-shell.js";
import { createComposerActions } from "./components/composer-actions.js";
import { createModelSelector } from "./components/model-selector.js";
import { createRuntimeOnboardingFeature } from "./runtime-onboarding-feature.js";
import { createSessionActionsMenu } from "./components/session-actions-menu.js";
import { createToolApprovalCard } from "./components/tool-approval-card.js";
import { textOf } from "./lib/text-format.js";
import { createConversationViewFeature as createConversationView } from "./controllers/conversation-view-feature.js";
import { initializeWorkspaceState, workspaceQueue, observeWorkspaceStateChange } from "./services/workspace-state.js";
import { createRuntimeWebClient } from "./services/runtime-web-client.js";
import { createHomeGuidancePreferences } from "./services/home-guidance-preferences.js";
import { createClientPreferences } from "./services/client-preferences.js";
import { createConversationWorkspaceActivation } from "./controllers/conversation-workspace-activation.js";
import { createOperationsController } from "./controllers/operations-controller.js";
import { createAppRealtimeTransport } from "./app-realtime-transport.js";
import { createSteerController } from "./controllers/steer-controller.js";
import { createSessionController } from "./controllers/session-controller.js";
import { createRealtimeEventController } from "./controllers/realtime-event-controller.js";
import { createRuntimeSelectionController } from "./controllers/runtime-selection-controller.js";
import { createAppEventBindings } from "./controllers/app-event-bindings.js";
import { createConversationSessionController } from "./controllers/conversation-session-controller.js";
import { createToolApprovalController } from "./controllers/tool-approval-controller.js";

const state = createAppState();

const dom = findAppDom();

const storage = await initializeWorkspaceState();
const preferences = createClientPreferences(storage);
createAppearanceFeature({ mount: dom.appearanceRoot, storage });
const runtimeClient = createRuntimeWebClient({
  getConfig: () => state.config,
  getEnvironmentId: selectedEnvironmentId,
  onMemoryDeleted: (environment, id) => createHomeGuidancePreferences(storage).forgetReviewed(environment, id),
});
let conversationSession;
let composerFeature;
let composerAttachments;
let composerQueueController;
let composerSubmitController;
let realtimeEvents;
let conversationView;
let configWorkspace;
let schedulesFeature;
let dashboardFeature;
let passiveLearning;
let homeComposer;
let runtimeSelection;
let projectsFeature;
let workspaceRoutes;
let notifications;
let skills;
let informationBasket;
let stepTimeouts;
const operationsController = createOperationsController({
  onSummaryChange: () => configWorkspace?.syncSummary(),
  dom,
  client: runtimeClient,
  getEnvironmentId: selectedEnvironmentId,
});
const realtimeTransport = createAppRealtimeTransport({
  state,
  getConfig: () => state.config,
  onMessage: handleRealtimeMessage,
  setConnectionLabel,
  rejectPendingSteers,
  recordControlEvent,
  onConnected: () => {
    void dashboardFeature?.refresh();
    schedulesFeature?.reconnect();
    passiveLearning?.reconnect();
    notifications?.reconnect();
    if (state.currentSessionId) subscribeSession(state.currentSessionId);
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
  onNavigationChange: () => { configWorkspace?.syncSummary(); workspaceRoutes?.sync(); },
  isWorkspaceAvailable: (destination) => {
    if (skills?.isWorkspaceAvailable(destination) === false) return false;
    if (informationBasket?.isWorkspaceAvailable(destination) === false) return false;
    if (!notifications?.isWorkspaceAvailable(destination)) return false;
    return schedulesFeature?.isWorkspaceAvailable(destination) ?? false;
  },
  onWorkspaceChange: (workspace) => {
    runtimeSelection?.rememberModelSelection();
    homeComposer?.setWorkspace(workspace);
    conversationView?.setWorkspace(workspace);
    projectsFeature?.workspaceChanged(workspace);
    runtimeSetupGuide.clearSecret();
    schedulesFeature?.setActive(workspace === "schedules");
    dashboardFeature?.setActive(workspace === "home");
    passiveLearning?.setWorkspace(workspace);
    notifications?.workspaceChanged(workspace);
    configWorkspace?.setWorkspace(workspace);
    runtimeSelection?.applyModelSelection();
    runtimeSelection?.renderPermissionMode();
    renderAttachmentComposer();
    updateComposerSendState();
    conversationSession?.markCurrentSessionReadSoon();
  },
  beforeWorkspaceChange: ({ from, to }) => {
    if (from === "schedules" && to !== "schedules")
      return schedulesFeature?.prepareLeave() ?? true;
    if (!isConfigurationWorkspace(from) || from === to) return true;
    if (!configWorkspace) return true;
    return configWorkspace.prepareDiscardChanges("leave configuration");
  },
});
skills = createSkillsFeature({ dom, client: runtimeClient, shell, getEnvironmentId: selectedEnvironmentId });
informationBasket = createInformationBasketFeature({ dom, client: runtimeClient, shell, realtime: realtimeTransport, getEnvironmentId: selectedEnvironmentId });
stepTimeouts = createStepTimeoutFeature({
  state, client: runtimeClient, shell,
  getEnvironmentId: selectedEnvironmentId,
  onApplied: () => configWorkspace?.reloadAppliedEnvironmentModels(),
});
notifications = createNotificationsFeature({
  dom, state, client: runtimeClient, shell, getEnvironmentId: selectedEnvironmentId, send: sendRealtime,
});
const { guide: runtimeSetupGuide, controller: runtimeOnboarding } =
  createRuntimeOnboardingFeature({
    dom, shell,
    runtimeClient,
    selectedEnvironmentId,
    state,
    reloadModels: () => configWorkspace.reloadAppliedEnvironmentModels(),
    reloadCatalog: loadModels,
    setMessageStatus: setMessageActivityStatus,
    onStateChange: () => {
      updateComposerSendState();
      renderAttachmentComposer();
      dashboardFeature?.runtimeAvailabilityChanged();
      schedulesFeature?.runtimeAvailabilityChanged();
      projectsFeature?.runtimeAvailabilityChanged();
      passiveLearning?.runtimeAvailabilityChanged();
      configWorkspace?.renderHomeGuidance();
    },
  });

const composerActions = createComposerActions({
  dom,
  onSendNext: () => dispatchComposerMessage("send_next"),
});
schedulesFeature = createSchedulesFeature({
  dom, state,
  onNavigationChange: () => workspaceRoutes?.sync(),
  client: runtimeClient,
  shell,
  selectedEnvironmentId,
  getCurrentSessionId: () => state.currentSessionId,
  getAgentModes: () => state.supportedAgentModes,
  isRuntimeReady: runtimeOnboarding.isReady,
  openSession: (sessionId, options) => conversationSession.openSession(sessionId, options),
});
passiveLearning = createPassiveLearningFeature({
  isRuntimeReady: runtimeOnboarding.isReady,
  onChange: () => configWorkspace?.renderHomeGuidance(),
  client: runtimeClient,
  getEnvironmentId: selectedEnvironmentId,
  learningRoot: dom.learningRoot,
  openLearning: () => shell.activateWorkspace("learning"),
  openComputerAccess: () => configWorkspace?.openComputerSetup(),
  showActivityMemories: async () => {
    if (await shell.activateWorkspace("memory"))
      configWorkspace?.showActivityMemories();
  },
});
dashboardFeature = createDashboardFeature({
  dom,
  state,
  preferences,
  client: runtimeClient,
  shell,
  schedules: schedulesFeature,
  selectedEnvironmentId,
  loadSessions,
  openSession: (sessionId, options) => conversationSession.openSession(sessionId, options),
  isComposerAvailable: runtimeOnboarding.isReady,
  passiveLearning,
});
const composerWorkspace = createComposerWorkspaceController({
  onSessionCreated: (sessionId) =>
    runtimeSelection.initializeSessionMode(sessionId),
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
  refreshComposerSubmissionState,
  uploadComposerAttachment,
  resizeComposerInput,
  dispatchComposerMessage,
} = createComposerSurfaceController({
  workspace: composerWorkspace,
  getHomeComposer: () => homeComposer,
  getChatAttachments: () => composerAttachments,
  getChatSubmit: () => composerSubmitController,
  refreshComposerSurfaces: () => composerFeature?.changed(),
  rememberModelSelection: rememberCurrentModelSelection,
  showToast: shell.showToast,
});
const sessionComposerQueue = workspaceQueue();
const sessionActionsMenu = createSessionActionsMenu({
  container: dom.sessionsList,
});
const sessionController = createSessionController({
  state,
  dom,
  onSidebarChange: renderSessions,
  sessionActionsMenu,
  renderGroups: (input) => projectsFeature?.renderSessionGroups(input) ?? false,
  getDeletedProjectIds: () => projectsFeature?.getDeletedProjectIds() ?? [],
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
  onSessionAttachmentsCleared: (scope) => composerWorkspace.drafts.clearAttachments(scope),
  onClearSessionMode: clearSessionMode,
  onSaveModelPreferences: saveModelPreferences,
  onReload: () => conversationSession.loadSessions(),
  onControlEvent: recordControlEvent,
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
  dom,
  filePreviewClient: runtimeClient,
  getFileEnvironmentId: selectedEnvironmentId,
  getFileSessionId: () => state.currentSessionId,
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
  getPendingApprovals: toolApprovalController.pendingEvents,
  createApprovalCard: toolApprovalController.createCard,
  copyText: (text) => navigator.clipboard.writeText(text),
  notify: (message, tone) => shell.showToast(message, tone),
  resolveAttachmentUrl: attachmentPreviewUrl,
  onOpenSchedule: (jobId) => schedulesFeature.openJob(jobId),
  canOpenSchedule: runtimeClient.supportsSchedules,
});
conversationSession = createConversationSessionController({
  onSessionCreated: (sessionId) =>
    runtimeSelection.initializeSessionMode(sessionId),
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
  suspendQueueRecovery: (canNavigate) =>
    composerQueueController.suspendRecoveryForNavigation(canNavigate),
  recoverBlockedQueue: (scope) =>
    composerQueueController.recoverForManualSend(scope),
  isCurrentComposerScope: (scope) =>
    composerQueueController.isCurrentScope(scope),
});
composerFeature = createComposerFeature({
  state, dom: composerWorkspace.chatDom, shell, client: runtimeClient,
  sessionQueue: sessionComposerQueue, conversationSession, conversationView,
  drafts: composerWorkspace.drafts, getDraft: composerWorkspace.chatView.current,
  getEnvironmentId: selectedEnvironmentId,
  ensureSession: () => conversationSession.ensureSession(),
  getSettings: () => {
    rememberCurrentModelSelection();
    return { agentMode: state.agentMode, toolPermissionMode: currentToolPermissionMode(), modelPreference: selectedModelPreference(), reasoningPreference: runtimeSelection.selectedReasoningPreference() };
  },
  steer: steerController.steer, composerActions,
  selectedModelSupportsImageInput: () => runtimeSelection.selectedModelSupportsImageInput(
    composerWorkspace.isChatVisible() ? dom.modelSelect.value : state.sessionModels[state.currentSessionId] || state.defaultModelProfileId),
  isComposerAvailable: runtimeOnboarding.isReady,
  getSubmissionBlock: runtimeOnboarding.submissionBlock,
  onSubmissionBlocked: runtimeOnboarding.presentSubmissionBlock,
  isVisible: composerWorkspace.isChatVisible, renderSessions, renderMessages,
  applyConversationChrome: applyConversationModeChrome,
  setMessageStatus: setMessageActivityStatus, recordControlEvent,
});
composerAttachments = composerFeature.attachments;
composerQueueController = composerFeature.queue;
composerSubmitController = composerFeature.submit;
projectsFeature = createProjectsFeature({
  preferences,
  isRuntimeReady: runtimeOnboarding.isReady,
  onSessionCreated: (sessionId) =>
    runtimeSelection.initializeSessionMode(sessionId),
  dom,
  state,
  client: runtimeClient,
  shell,
  selectedEnvironmentId,
  conversationSession,
  renderSessions,
  closeFilePreview: conversationView.closeFilePreview,
  prepareConversation: createConversationWorkspaceActivation({ state, shell, composerQueue: composerQueueController, selectedEnvironmentId }),
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
  markCurrentSessionReadSoon: conversationSession.markCurrentSessionReadSoon,
  applySessionTitleUpdate: conversationSession.applySessionTitleUpdate,
  setMessageActivityStatus,
  updateComposerSendState,
  drainQueuedComposerMessage: (scope) => composerQueueController.drain(scope),
  loadSessions: conversationSession.loadSessions,
});

const modelSelector = createModelSelector({
  select: dom.modelSelect,
  button: dom.modelSelectButton,
  valueLabel: dom.modelSelectValue,
  menu: dom.modelSelectMenu,
  onOpen: () => {
    state.agentModeMenuOpen = false;
    state.reasoningBudgetMenuOpen = false;
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
  onReasoningConfigurationApplied: () => configWorkspace.reloadAppliedEnvironmentModels(),
  onModelCatalogLoading: runtimeOnboarding.beginCatalogLoad,
  onModelCatalogLoaded: runtimeOnboarding.applyCatalog,
  onModelCatalogUnavailable: runtimeOnboarding.catalogUnavailable,
  getComposerSessionId: composerWorkspace.composerSessionId,
});
homeComposer = createHomeComposerFeature({
  workspace: composerWorkspace,
  composer: composerFeature,
  selectedModelSupportsImageInput: () => runtimeSelection.selectedModelSupportsImageInput(
    composerWorkspace.isHome() ? dom.modelSelect.value : state.sessionModels[composerWorkspace.ensureHomeSession()] || state.defaultModelProfileId),
  activateHomeSession: createHomeConversationActivation({
    state, shell, conversationSession, composerQueue: composerQueueController,
    preferences, selectedEnvironmentId, renderSessions, renderMessages,
    applyModelSelection: applyModelSelectionForCurrentSession,
    setCurrentTitle: setCurrentSessionTitle, updateComposerSendState,
  }),
});
const appEventBindings = createAppEventBindings({
  onNavigationChange: () => workspaceRoutes?.sync(),
  onSessionCreated: (sessionId) =>
    runtimeSelection.initializeSessionMode(sessionId),
  state,
  dom,
  shell,
  modelSelector,
  composerActions,
  actions: {
    renderSessions,
    loadSessions,
    prepareQueueRecovery: () => composerQueueController.prepareRecoveryForNavigation(),
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
    beforeEnvironmentChange: () => prepareEnvironmentWorkspaceChanges(schedulesFeature, configWorkspace, skills),
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
    refreshComposerSubmissionState,
    loadRuntimeStatus,
    loadRuntimeLogs,
    loadSystemHealth,
  },
});

configWorkspace = createConfigurationFeature({
  compactHomeWidgets: dashboardFeature.compactWidgets,
  getOperationsSummary: () => operationsController.summary(shell.activeOperationsTab()),
  getLearningSnapshot: () => passiveLearning?.snapshot(),
  isRuntimeReady: runtimeOnboarding.isReady,
  isComputerAccessAvailable: () => shell.isWorkspaceAvailable("config"),
  onNavigationChange: () => workspaceRoutes?.sync(),
  state,
  selection: runtimeSelection,
  changeEnvironment: (...args) => appEventBindings.changeEnvironment(...args),
  onConfigurationApplied: loadModels,
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

function saveEnvironmentId(environmentId) {
  return preferences.saveEnvironmentId(environmentId);
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
  stepTimeouts?.syncScope();
  notifications?.presenceChanged();
  conversationView.render();
  workspaceRoutes?.sync();
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
  void stepTimeouts?.handleEvent(message);
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
  observeWorkspaceStateChange(message);
  dashboardFeature?.handleRealtime(message);
  schedulesFeature?.handleRealtime(message);
  passiveLearning?.handleRealtime(message);
  notifications?.handleRealtime(message);
  if (!isWorkspaceChange(message)) realtimeEvents.handle(message);
  void stepTimeouts?.handleEvent(message);
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

async function loadRuntimeStatus() {
  await operationsController.loadRuntimeStatus();
}

async function loadRuntimeLogs() {
  await operationsController.loadRuntimeLogs();
}

async function loadSystemHealth() {
  await operationsController.loadSystemHealth();
}

void startWebApp({
  state,
  dom,
  preferences,
  shell,
  homeComposer,
  dashboard: dashboardFeature,
  learning: passiveLearning,
  notifications,
  skills,
  informationBasket,
  schedules: schedulesFeature,
  projects: projectsFeature,
  selection: runtimeSelection,
  client: runtimeClient,
  bindables: [
    notifications,
    sessionActionsMenu,
    projectsFeature,
    conversationView,
    configWorkspace,
    composerActions,
    modelSelector,
    runtimeOnboarding,
  ],
  bindEvents: () => bindWebAppWorkspaceLifecycle({
    appEventBindings, dom, runtimeSetupGuide, reloadModels: loadModels,
    conversationSession, homeComposer, dashboardFeature, passiveLearning, notifications,
    operations: operationsController,
  }),
  renderComposer: () => {
    resizeComposerInput();
    updateComposerSendState();
  },
  renderMessages,
  operations: operationsController,
  configuration: configWorkspace,
  realtime: realtimeTransport,
  restoreLastSession,
  navigation: { bindings: appEventBindings, conversation: conversationSession },
  onNavigationReady: (routes) => (workspaceRoutes = routes),
});
