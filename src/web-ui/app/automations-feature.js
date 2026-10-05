import { createAutomationsController } from "./controllers/automations-controller.js";
import { createAutomationsWorkspace } from "./components/automations/workspace.js";
import { createAutomationChatRunProjection } from "./components/automations/chat-run-projection.js";
import { openAutomationAuthoringChat } from "./components/automations/authoring-entry.js";

export function createAutomationsFeature({
  dom, client, shell, realtime, getEnvironmentId, onNavigationChange,
  documentRoot = document,
}) {
  if (!dom.automationsRoot || !dom.automationsWorkspaceButton || !dom.automationChatRunPanel) {
    return {
      refreshAvailability() {},
      isWorkspaceAvailable: (destination) => destination !== "automations",
      selectedAutomationId: () => "", selectedRunId: () => "",
      navigationRevision: () => 0, openRoute: async () => false,
      prepareRouteChange: () => true,
      chatRunId: () => "", openChatRun: async () => false,
    };
  }
  let view;
  const controller = createAutomationsController({
    client, getEnvironmentId, onNavigationChange,
    isEditingDirty: () => view?.isDirty() || false,
    render: (snapshot) => view?.render(snapshot),
  });
  const chatRun = createAutomationChatRunProjection({
    dom, client, getEnvironmentId, onNavigationChange,
    returnToStudio: (run) => {
      chatRun.clear();
      if (!shell.activateWorkspace("automations")) return;
      void controller.openRoute(run?.automationId || "", run?.id || "");
    },
  });
  view = createAutomationsWorkspace({
    root: dom.automationsRoot,
    actions: {
      ...controller,
      openAuthoringChat(automationId, revision) {
        return openAutomationAuthoringChat({ dom, shell, automationId, revision });
      },
      showChatRun(runId) {
        if (!shell.activateWorkspace("chat")) return false;
        return chatRun.open(runId);
      },
    },
    documentRoot,
  });
  shell.addWorkspaceGuard(({ from, to }) => {
    if (from !== "automations" || to === "automations") return true;
    return view.prepareLeave();
  });
  dom.chatWorkspaceButton.addEventListener("click", () => chatRun.clear());
  shell.subscribeWorkspaceChange((workspace) => {
    controller.setWorkspaceActive(workspace === "automations");
    chatRun.workspaceChanged(workspace);
  });
  dom.environmentSelect.addEventListener("change", () => queueMicrotask(() => {
    controller.environmentChanged();
    chatRun.clear();
  }));
  documentRoot.addEventListener("visibilitychange", () => {
    controller.visibilityChanged();
    chatRun.visibilityChanged();
  });
  realtime.subscribeMessages?.((message) => {
    controller.handleRealtime(message);
    chatRun.handleRealtime(message);
  });
  realtime.subscribeConnected?.(() => {
    controller.reconnect();
    chatRun.reconnect();
  });
  return {
    refreshAvailability() {
      const available = client.supportsAutomations();
      dom.automationsWorkspaceButton.hidden = !available;
      dom.automationsWorkspaceButton.disabled = !available || dom.automationsWorkspaceButton.dataset.onboardingBlocked === "true";
      if (!available) controller.setWorkspaceActive(false);
      if (!available) chatRun.clear();
    },
    isWorkspaceAvailable(destination) {
      return destination !== "automations" || client.supportsAutomations();
    },
    selectedAutomationId: controller.selectedAutomationId,
    selectedRunId: controller.selectedRunId,
    chatRunId: chatRun.runId,
    navigationRevision: controller.navigationRevision,
    openRoute: controller.openRoute,
    async openChatRun(runId) {
      if (runId) shell.setSessionsDrawerOpen(false, { focus: false });
      await chatRun.open(runId);
      return true;
    },
    prepareRouteChange(route) {
      if (shell.activeWorkspace() !== "automations") return true;
      const changesIdentity = route.workspace !== "automations" ||
        route.automation !== controller.selectedAutomationId() ||
        route.run !== controller.selectedRunId() ||
        route.environment !== getEnvironmentId();
      return !changesIdentity || view.prepareLeave();
    },
  };
}
