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
  let sync;
  let settings;
  let conversation;
  let awaitingOpening = false;
  const isAvailable = () => client.supportsSparkChat?.() === true;
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
  function openSettings() {
    if (!shell.activateWorkspace("learning")) return;
    selectLearningView(dom.learningRoot, "chat", true);
    panel.setOpen(false, { focus: false });
  }
  function openModelSettings() {
    if (!shell.activateWorkspace("learning")) return;
    selectLearningView(dom.learningRoot, "settings", true);
    dom.learningRoot.querySelector('[data-learning-setting="proactiveModelProfileId"]')?.focus();
    panel.setOpen(false, { focus: false });
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
    client, getEnvironmentId, conversation, isAvailable,
    onConfiguration: (next) => {
      const changedModel = configuration?.modelProfileId !== next.modelProfileId;
      configuration = next; settings?.render(next, getEnvironmentId());
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
    if (!opened) { conversation.view.closeFilePreview(); return; }
    if (!configuration) { awaitingOpening = true; void sync.refresh(); return; }
    reading.open(); conversation.render(); conversation.update();
    void sync.refresh();
  });

  async function open(messageId, reference) {
    if (!isAvailable()) return false;
    const scope = getEnvironmentId();
    try { if (!configuration || reference !== undefined) await sync.refresh({ wait: true }); }
    catch (error) { shell.showToast(`SPARK could not be opened: ${error.message}`, "failed"); return false; }
    if (scope !== getEnvironmentId()) return false;
    if (!configuration) return false;
    panel.setOpen(true);
    const target = resolveSparkMessageTarget(configuration.snapshot?.messages, messageId, reference);
    reading.open(target); conversation.render(); conversation.update();
    return true;
  }
  function environmentChanged() {
    const next = getEnvironmentId();
    panel.setAvailable(isAvailable());
    if (environmentId === next) return;
    environmentId = next;
    configuration = undefined; readState = undefined;
    awaitingOpening = panel.isOpen();
    sync.reset(); reading.reset(); notices.reset(); conversation.reset(); panel.hideNotice();
    settings.render(undefined, next);
    if (isAvailable()) void sync.refresh({ consolidated: true });
  }
  function handleRealtime(message) {
    environmentChanged();
    if (!isAvailable()) return;
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
    prepareEnvironmentChange: conversation.prepareEnvironmentChange,
    async openSession(sessionId, messageId, reference) {
      if (!isAvailable() || !sessionId) return false;
      const scope = getEnvironmentId();
      try { if (!configuration) await sync.refresh({ wait: true }); }
      catch (error) {
        shell.showToast(`SPARK could not be opened: ${error.message}`, "failed");
        return true;
      }
      if (scope !== getEnvironmentId()) return true;
      if (sessionId !== configuration?.sessionId) return false;
      return open(messageId, reference);
    },
    bind() {
      conversation.bind();
      realtime.subscribeMessages(handleRealtime);
      realtime.subscribeConnectionChanged?.(() => conversation.update());
      realtime.subscribeConnected(() => { environmentChanged(); void sync.refresh({ consolidated: true, rehydrate: true }); });
      dom.environmentSelect.addEventListener("change", () => queueMicrotask(environmentChanged));
      shell.subscribeWorkspaceChange(() => { environmentChanged(); if (panel.isOpen()) reading.scheduleRead(); });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void sync.refresh({ consolidated: true });
      });
      window.addEventListener("focus", () => { conversation.update(); reading.scheduleRead(); });
    },
  };
}
