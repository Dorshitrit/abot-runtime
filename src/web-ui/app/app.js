import { createWorkspaceShell } from "./components/workspace-shell.js";
import { createConfigWorkspace } from "./components/config-workspace.js";
import { createComposerActions } from "./components/composer-actions.js";
import { createModelSelector } from "./components/model-selector.js";
import { createRuntimeSetupGuide } from "./components/runtime-setup-guide.js";
import { createLongTermMemorySetup } from "./components/long-term-memory-setup.js";
import { createLongTermMemoryManager } from "./components/long-term-memory/manager.js";
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
import { createLongTermMemoryController } from "./controllers/long-term-memory/controller.js";

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

const dom = {
  app: document.getElementById("app"),
  chatWorkspaceButton: document.getElementById("chatWorkspaceButton"),
  configWorkspaceButton: document.getElementById("configWorkspaceButton"),
  chatPanel: document.querySelector(".chat-panel"),
  sessionsPanel: document.querySelector(".sessions-panel"),
  configWorkspacePanel: document.getElementById("configWorkspacePanel"),
  closeConfigWorkspaceButton: document.getElementById(
    "closeConfigWorkspaceButton",
  ),
  connectionLabel: document.getElementById("connectionLabel"),
  environmentSelect: document.getElementById("environmentSelect"),
  agentPickerButton: document.getElementById("agentPickerButton"),
  agentPickerMenu: document.getElementById("agentPickerMenu"),
  newSessionButton: document.getElementById("newSessionButton"),
  refreshSessionsButton: document.getElementById("refreshSessionsButton"),
  closeSessionsButton: document.getElementById("closeSessionsButton"),
  sessionsToggleButton: document.getElementById("sessionsToggleButton"),
  sessionSearchInput: document.getElementById("sessionSearchInput"),
  sessionsCount: document.getElementById("sessionsCount"),
  sessionsList: document.getElementById("sessionsList"),
  sessionTitle: document.getElementById("sessionTitle"),
  agentModeButton: document.getElementById("agentModeButton"),
  agentModeMenu: document.getElementById("agentModeMenu"),
  permissionModeButton: document.getElementById("permissionModeButton"),
  permissionModeMenu: document.getElementById("permissionModeMenu"),
  modelSelect: document.getElementById("modelSelect"),
  modelSelectButton: document.getElementById("modelSelectButton"),
  modelSelectValue: document.getElementById("modelSelectValue"),
  modelSelectMenu: document.getElementById("modelSelectMenu"),
  messagesList: document.getElementById("messagesList"),
  runtimeSetupGuide: document.getElementById("runtimeSetupGuide"),
  messageStatusRegion: document.getElementById("messageStatusRegion"),
  jumpToLatestButton: document.getElementById("jumpToLatestButton"),
  composerForm: document.getElementById("composerForm"),
  attachmentButton: document.getElementById("attachmentButton"),
  attachmentInput: document.getElementById("attachmentInput"),
  attachmentPreview: document.getElementById("attachmentPreview"),
  composerInput: document.getElementById("composerInput"),
  composerContextWindow: document.getElementById("composerContextWindow"),
  composerPlan: document.getElementById("composerPlan"),
  composerSubmitControl: document.getElementById("composerSubmitControl"),
  sendButton: document.getElementById("sendButton"),
  sendButtonLabel: document.getElementById("sendButtonLabel"),
  sendNextMenuButton: document.getElementById("sendNextMenuButton"),
  sendNextMenu: document.getElementById("sendNextMenu"),
  sendNextButton: document.getElementById("sendNextButton"),
  refreshRuntimeButton: document.getElementById("refreshRuntimeButton"),
  runtimeStatus: document.getElementById("runtimeStatus"),
  refreshLogsButton: document.getElementById("refreshLogsButton"),
  runtimeLogs: document.getElementById("runtimeLogs"),
  refreshHealthButton: document.getElementById("refreshHealthButton"),
  healthStatus: document.getElementById("healthStatus"),
  refreshConfigButton: document.getElementById("refreshConfigButton"),
  configStatus: document.getElementById("configStatus"),
  configDashboard: document.getElementById("configDashboard"),
  panelBackdrop: document.getElementById("panelBackdrop"),
  toastRegion: document.getElementById("toastRegion"),
  operationsTabButtons: [
    ...document.querySelectorAll(".operations-tab-button"),
  ],
  operationsTabPages: [...document.querySelectorAll(".operations-tab-page")],
};

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
  onError: () => setConnectionLabel("Connection issue", true),
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
  beforeWorkspaceChange: ({ from, to }) => {
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
  },
});

const composerActions = createComposerActions({
  dom,
  onSendNext: () => dispatchComposerMessage("send_next"),
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
  selectedModelSupportsImageInput,
  ensureSession: () => conversationSession.ensureSession(),
  onSendStateChange: updateComposerSendState,
  onControlEvent: recordControlEvent,
  isComposerAvailable: runtimeOnboarding.isReady,
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
  dom,
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
  dom,
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
const runtimeSelection = createRuntimeSelectionController({
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
    beforeEnvironmentChange: () =>
      configWorkspace.prepareDiscardChanges("change environment"),
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

const longTermMemorySetup = createLongTermMemorySetup({
  getEnvironmentId: selectedEnvironmentId,
  loadStatus: (environmentId) =>
    runtimeClient.loadLongTermMemoryStatus(environmentId),
  discoverModels: (providerId, environmentId) =>
    runtimeClient.discoverLongTermMemoryModels({
      environmentId,
      providerId,
    }),
  enableMemory: (input, environmentId) =>
    runtimeClient.enableLongTermMemory({
      environmentId,
      ...input,
    }),
  disableMemory: (environmentId) =>
    runtimeClient.disableLongTermMemory(environmentId),
  recordControlEvent,
  beginRuntimeMutation: () =>
    configWorkspace?.beginExternalRuntimeMutation() ?? false,
  refreshRuntimeConfig: () =>
    configWorkspace?.refreshAfterExternalRuntimeMutation() ??
    Promise.resolve(false),
  endRuntimeMutation: () => configWorkspace?.endExternalRuntimeMutation(),
});

let longTermMemoryManager;
const longTermMemoryController = createLongTermMemoryController({
  client: runtimeClient,
  getEnvironmentId: selectedEnvironmentId,
  render: (snapshot) => longTermMemoryManager?.render(snapshot),
});
longTermMemoryManager = createLongTermMemoryManager({
  actions: longTermMemoryController,
});

configWorkspace = createConfigWorkspace({
  dom: {
    refreshConfigButton: dom.refreshConfigButton,
    configStatus: dom.configStatus,
    configDashboard: dom.configDashboard,
  },
  loadDashboard: () =>
    runtimeClient.loadConfigDashboard(selectedEnvironmentId()),
  saveFile: ({ kind, id, config }) =>
    runtimeClient.saveConfigFile({
      environmentId: selectedEnvironmentId(),
      kind,
      id,
      config,
    }),
  memorySetup: longTermMemorySetup,
  memoryManagement: {
    load: () => longTermMemoryController.load(),
    mount: (root) => longTermMemoryManager.mount(root),
  },
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
}

function configuredEnvironmentOptions() {
  return runtimeSelection.configuredEnvironmentOptions();
}

function renderEnvironmentSelectOptions() {
  runtimeSelection.renderEnvironmentOptions();
}

function selectedEnvironmentId() {
  return runtimeSelection.selectedEnvironmentId();
}

function environmentOptions() {
  return runtimeSelection.environmentOptions();
}

function renderAgentPicker() {
  runtimeSelection.renderAgentPicker();
}

function selectedModelPreference() {
  return runtimeSelection.selectedModelPreference();
}

function selectedModelSupportsImageInput() {
  return runtimeSelection.selectedModelSupportsImageInput();
}

function loadPinnedSessions() {
  runtimeSelection.loadPreferences();
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

function renderAttachmentComposer() {
  composerAttachments.render();
}

function removeUnsupportedPendingImages() {
  composerAttachments.removeUnsupportedImages();
}

function attachmentPreviewUrl(attachment) {
  return composerAttachments.previewUrl(attachment);
}

function updateComposerSendState() {
  composerSubmitController.updateSendState();
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

function connectRealtime() {
  realtimeTransport.connect();
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

async function uploadComposerAttachment(file) {
  await composerAttachments.upload(file);
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
}

function resizeComposerInput() {
  composerSubmitController.resize();
}

function suspendRecoveredComposerReleaseForNavigation() {
  return composerQueueController.suspendRecoveryForNavigation();
}

function dispatchComposerMessage(requestedAction = "") {
  composerSubmitController.dispatch(requestedAction);
}

async function boot() {
  loadPinnedSessions();
  shell.load();
  shell.bind();
  sessionActionsMenu.bind();
  conversationView.bind();
  configWorkspace.bind();
  composerActions.bind();
  modelSelector.bind();
  runtimeOnboarding.bind();
  bindEvents();
  resizeComposerInput();
  updateComposerSendState();
  applyConversationModeChrome();
  renderMessages();
  state.config = await runtimeClient.loadWebConfig();
  renderEnvironmentSelectOptions();
  const options = environmentOptions();
  const saved = savedEnvironmentId();
  const fallbackEnvironmentId =
    textOf(state.config.defaultEnvironmentId).trim() || options[0]?.value || "";
  dom.environmentSelect.value = options.some((option) => option.value === saved)
    ? saved
    : fallbackEnvironmentId;
  saveEnvironmentId(dom.environmentSelect.value);
  renderAgentPicker();
  connectRealtime();
  await Promise.allSettled([
    loadModels(),
    loadAgentMode(),
    loadRuntimeStatus(),
    loadSystemHealth(),
    loadRuntimeConfig(),
  ]);
  await restoreLastSession();
}

void boot().catch((error) => {
  setConnectionLabel(
    error instanceof Error ? error.message : String(error),
    true,
  );
});
