import { syncChatgptPlanIndicator } from "./components/chatgpt-plan-indicator.js";
import { createSparkChatPanel } from "./components/spark-chat/panel.js";
import { isSparkModelUnavailable } from "./components/spark-chat/empty-state.js";
import { createSparkChatSettings } from "./components/spark-chat/settings.js";
import { createSparkChatReading } from "./controllers/spark-chat-reading.js";
import { createSparkChatNotices } from "./controllers/spark-chat-notices.js";
import { createSparkChatSync } from "./controllers/spark-chat-sync.js";
import { createSparkChatConversation } from "./spark-chat-conversation.js";
import { selectLearningView } from "./components/passive-learning/workspace-view.js";
import { isWorkspaceChange } from "./lib/workspace-change.js";
import { reconcileSparkReadState } from "./lib/spark-chat-read-state.js";
import { resolveSparkMessageTarget } from "./lib/spark-chat-address.js";

export function createSparkChatFeature({ dom, state: appState, client, shell, realtime, getEnvironmentId, onOpenSchedule = () => {}, captureHandoffNavigation }) {
  const panel = createSparkChatPanel({ launcherAnchor: dom.environmentSelect.closest(".rail-runtime") });
  let configuration;
  let readState;
  let environmentId = "";
  let available = false;
  let accessRevision = 0;
  let sync;
  let settings;
  let conversation;
  let awaitingOpening = false;
  let restoringOpen = false;
  function isSparkAvailable() {
    if (client.supportsSparkChat?.() !== true) return false;
    return shell.isWorkspaceAvailable("learning");
  }
  function canCompleteSparkOpening(scope, revision) {
    if (!isSparkAvailable()) return false;
    if (scope !== getEnvironmentId()) return false;
    return revision === accessRevision;
  }
  function hasSparkAccessChanged(nextEnvironment, nextAvailable) {
    if (environmentId !== nextEnvironment) return true;
    return available !== nextAvailable;
  }
  const getSubmissionBlock = () => {
    if (!configuration?.sessionId) return { message: "SPARK conversation is loading." };
    if (isSparkModelUnavailable(configuration)) return { message: "Choose a model under Proactive mode in SPARK settings." };
    if (!sync?.isReady()) return { message: "SPARK is restoring this conversation." };
    if (appState.runtimeAvailability?.status !== "ready") return { message: "The Runtime is not ready. Check System settings." };
    return null;
  };
  const reading = createSparkChatReading({
    dom: panel.dom, client, getEnvironmentId, isOpen: panel.isOpen,
    getMessages: () => conversation?.state.messages || [],
    onReadState: applyReadState,
    onError: (error) => {
      if (["read_generation_changed", "visible_message_receipt_stale"].includes(error.code)) { void sync.refresh(); return; }
      conversation.status(`Read status unavailable: ${error.message}`);
    },
  });
  const notices = createSparkChatNotices({ showNotice: panel.showNotice, setUnread: panel.setUnread });
  function applyReadState(next, receipt) {
    if (!next) return;
    readState = reconcileSparkReadState(readState, next, receipt);
    reading.setReadState(readState);
    if (awaitingOpening && panel.isOpen()) { reading.open(); awaitingOpening = false; }
    if (Number.isFinite(readState.unreadCount)) panel.setUnread(readState.unreadCount);
    if (readState.readStateStatus === "unavailable") conversation.status("Read status is temporarily unavailable.");
  }
  async function openLearningSettings(view) {
    const scope = getEnvironmentId();
    const revision = accessRevision;
    const activate = await shell.prepareWorkspaceActivation("learning");
    if (!activate || !canCompleteSparkOpening(scope, revision)) return false;
    if (!activate()) return false;
    selectLearningView(dom.learningRoot, view, true);
    panel.setOpen(false, { focus: false });
    return true;
  }
  const openSettings = () => openLearningSettings("chat");
  async function openModelSettings() {
    if (!await openLearningSettings("settings")) return;
    dom.learningRoot.querySelector('[data-learning-setting="proactiveModelProfileId"]')?.focus();
  }
  conversation = createSparkChatConversation({
    dom: panel.dom, client, shell, getEnvironmentId,
    getConfiguration: () => configuration, isOpen: panel.isOpen,
    isConnected: () => appState.connected,
    getSubmissionBlock, scrollBehavior: reading,
    onOpenSchedule, onOpenModelSettings: openModelSettings,
    captureHandoffNavigation, onHandoffOpened: () => panel.setOpen(false),
    refresh: () => sync?.refresh(), onReadState: applyReadState,
    sendRealtime: realtime.send,
    onComposerStateChange: (sending) => sync?.composerChanged(sending),
  });
  sync = createSparkChatSync({
    client, getEnvironmentId, conversation, isAvailable: isSparkAvailable,
    onConfiguration: (next) => {
      const changedModel = configuration?.modelProfileId !== next.modelProfileId;
      configuration = next; settings?.render(next, getEnvironmentId());
      syncChatgptPlanIndicator({ anchor: panel.dom.composerForm, documentRoot: document, usingPlan: next.usingChatgptPlan === true });
      if (changedModel) conversation.attachments.removeUnsupportedImages();
    },
    onReadState: applyReadState,
    onSnapshot: (snapshot, _readState, options) => notices.reconcile(snapshot, readState, options),
    onHistoryReset() {
      conversation.reset(); reading.reset(); notices.reset(); readState = undefined;
      panel.hideNotice(); awaitingOpening = panel.isOpen();
    },
    onError: (error) => conversation.status(`SPARK unavailable: ${error.message}`),
  });
  settings = createSparkChatSettings({
    root: dom.learningRoot, getWebConfig: () => appState.config,
    getAgentMode: () => conversation.state.agentMode,
    getReasoningPreference: () => conversation.getReasoningPreference(),
    onReasoningPreferenceChange: (preference) => conversation.setReasoningPreference(preference),
    onAgentModeChange: (mode) => conversation.setAgentMode(mode),
    onSave: async (toolPermissionMode) => {
      const scope = getEnvironmentId();
      const result = await client.configureSparkChat({ toolPermissionMode }, scope);
      if (scope !== getEnvironmentId()) return;
      configuration = { ...configuration, ...result }; settings.render(configuration, scope); conversation.update();
    },
    onClear: async () => {
      if (!configuration?.sessionId) return;
      const scope = getEnvironmentId();
      await client.clearSessionMessages(configuration.sessionId, scope);
      if (scope !== getEnvironmentId()) return;
      conversation.reset(); reading.reset(); notices.reset(); readState = undefined;
      sync.reset(); panel.hideNotice();
      await sync.refresh({ wait: true });
    },
    onOpen: () => void open(),
    onResetPosition: () => panel.resetPosition(),
    onOpenModelSettings: openModelSettings,
  });
  panel.dom.settingsButton.addEventListener("click", openSettings);
  panel.onToggle((opened) => {
    if (!opened) {
      accessRevision += 1;
      conversation.view.closeFilePreview();
      return;
    }
    if (!isSparkAvailable()) { panel.setOpen(false, { focus: false }); return; }
    if (!restoringOpen) void open();
  });

  async function open(messageId, reference) {
    if (!isSparkAvailable()) return false;
    const scope = getEnvironmentId();
    const revision = accessRevision;
    try { await sync.refresh({ wait: true, consolidated: true }); }
    catch (error) {
      if (!canCompleteSparkOpening(scope, revision)) return false;
      shell.showToast(`SPARK could not be opened: ${error.message}`, "failed");
      return false;
    }
    if (!canCompleteSparkOpening(scope, revision)) return false;
    if (!configuration) return false;
    const requestedTarget = messageId ?? readState?.unreadMessageIds?.[0];
    if (!await ensureSparkTargetHistory(requestedTarget, reference, scope, revision)) return false;
    if (!canCompleteSparkOpening(scope, revision)) return false;
    const target = resolveSparkMessageTarget(conversation.state.messages, requestedTarget, reference);
    reading.open(target); restoringOpen = true; panel.setOpen(true); restoringOpen = false;
    conversation.render(); conversation.update();
    return true;
  }
  async function ensureSparkTargetHistory(target, reference, scope, revision) {
    if (target == null) return true;
    if (reference === null) return true;
    if (resolveSparkMessageTarget(conversation.state.messages, target, reference)) return true;
    try {
      await conversation.session.openSession(configuration.sessionId, { preserveCurrentWindow: true, page: {
        targetMessageId: String(target), targetCreatedAt: reference?.createdAt,
        targetRequestId: reference?.requestId ?? undefined,
      } });
    } catch (error) {
      if (!canCompleteSparkOpening(scope, revision)) return false;
      shell.showToast(`SPARK history unavailable: ${error.message}`, "failed");
      return false;
    }
    return canCompleteSparkOpening(scope, revision);
  }
  function shouldRestoreUnavailableSparkFocus(nextAvailable) {
    if (nextAvailable) return false;
    const home = dom.homeWorkspaceButton;
    if (!home) return false;
    if (home.disabled) return false;
    if (home.hidden) return false;
    if (home.inert) return false;
    if (home.closest?.("[hidden], [inert]")) return false;
    const focused = document.activeElement;
    if (!focused) return false;
    if (panel.root?.contains(focused)) return true;
    return panel.dom.launcherButton?.contains(focused) === true;
  }
  function environmentChanged() {
    const next = getEnvironmentId();
    const nextAvailable = isSparkAvailable();
    if (shouldRestoreUnavailableSparkFocus(nextAvailable)) dom.homeWorkspaceButton.focus({ preventScroll: true });
    panel.setAvailable(nextAvailable);
    if (!hasSparkAccessChanged(next, nextAvailable)) return;
    environmentId = next; available = nextAvailable; accessRevision += 1;
    configuration = undefined; readState = undefined;
    syncChatgptPlanIndicator({ anchor: panel.dom.composerForm, documentRoot: document, usingPlan: false });
    awaitingOpening = panel.isOpen();
    sync.reset(); reading.reset(); notices.reset(); conversation.reset(); panel.hideNotice();
    settings.render(undefined, next);
    if (isSparkAvailable()) void sync.refresh({ consolidated: true });
  }
  function handleRealtime(message) {
    environmentChanged();
    if (!isSparkAvailable()) return;
    const environment = message.environmentId || message.environment;
    if (environment && environment !== getEnvironmentId()) return;
    if (message.type === "learning.changed") { sync.modelChanged(); return; }
    if (isWorkspaceChange(message)) {
      const sessionId = message.sessionId || message.change?.sessionId;
      if (!sessionId || sessionId === configuration?.sessionId) void sync.refresh();
      return;
    }
    if (message.sessionId !== configuration?.sessionId) {
      if (message.sessionId) return;
      if (!message.requestId && message.type !== "steer_ack" && message.type !== "tool_approval_ack") return;
    }
    const unknownRequest = message.requestId && !conversation.session.requestBelongsToCurrentView(message.requestId);
    if (unknownRequest && message.sessionId === configuration?.sessionId) { void sync.refresh(); return; }
    conversation.handleRealtime(message);
    if (["chat_message", "completed", "failed", "chat_read_state"].includes(message.type)) void sync.refresh();
  }
  return {
    open, environmentChanged,
    async sessionsReset(result, scope) {
      conversation.clearResetDraftData(scope, result.clearedSessionIds);
      if (scope !== getEnvironmentId()) return;
      if (!result.clearedSessionIds.includes(configuration?.sessionId)) return;
      conversation.reset(); reading.reset(); notices.reset(); readState = undefined;
      sync.reset(); panel.hideNotice(); awaitingOpening = panel.isOpen();
      await sync.refresh({ wait: true, consolidated: true });
    },
    prepareEnvironmentChange: conversation.prepareEnvironmentChange,
    async openSession(sessionId, messageId, reference) {
      if (!isSparkAvailable()) return false;
      if (!sessionId) return false;
      const scope = getEnvironmentId();
      const revision = accessRevision;
      try { if (!configuration) await sync.refresh({ wait: true }); }
      catch (error) {
        if (!canCompleteSparkOpening(scope, revision)) return true;
        shell.showToast(`SPARK could not be opened: ${error.message}`, "failed");
        return true;
      }
      if (!canCompleteSparkOpening(scope, revision)) return true;
      if (sessionId !== configuration?.sessionId) return false;
      const opened = await open(messageId, reference);
      if (!canCompleteSparkOpening(scope, revision)) return true;
      return opened;
    },
    bind() {
      conversation.bind();
      realtime.subscribeMessages(handleRealtime);
      realtime.subscribeConnectionChanged?.(() => conversation.update());
      realtime.subscribeConnected(() => { environmentChanged(); void sync.refresh({ consolidated: true, rehydrate: true }); });
      dom.environmentSelect.addEventListener("change", () => queueMicrotask(environmentChanged));
      shell.subscribeRuntimeAvailabilityChange(environmentChanged);
      shell.subscribeWorkspaceChange(() => { environmentChanged(); if (panel.isOpen()) reading.scheduleRead(); });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void sync.refresh({ consolidated: true });
      });
      window.addEventListener("focus", () => { conversation.update(); reading.scheduleRead(); });
    },
  };
}
