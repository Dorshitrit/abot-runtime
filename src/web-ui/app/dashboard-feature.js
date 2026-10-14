import { createWorkspaceConversationOpener } from "./controllers/workspace-conversation-opener.js";
import { createDashboardWorkspace } from "./components/dashboard/workspace.js";
import { createDashboardController } from "./controllers/dashboard-controller.js";
import { createDashboardApprovalsController } from "./controllers/dashboard-approvals-controller.js";
import { dashboardJobInitialValues } from "./lib/dashboard-job-templates.js";
import { filterSessionsByArchiveState } from "./lib/session-archive-visibility.js";

export function createDashboardFeature({
  dom,
  state,
  preferences,
  client,
  shell,
  schedules,
  selectedEnvironmentId,
  loadSessions,
  openSession,
  isComposerAvailable,
  passiveLearning,
}) {
  const openConversation = createWorkspaceConversationOpener({ state, shell, openSession });
  let view;
  let controller;
  const approvals = createDashboardApprovalsController({
    client,
    getEnvironmentId: selectedEnvironmentId,
    render: () => controller?.publish(),
  });
  controller = createDashboardController({
    client,
    getEnvironmentId: selectedEnvironmentId,
    getSessions: () => state.sessions,
    loadSessions,
    isRuntimeReady: isComposerAvailable,
    approvalData: approvals,
    render: (snapshot) => {
      const sessions = filterSessionsByArchiveState(snapshot.sessions,
        preferences?.loadSessionSidebar?.(selectedEnvironmentId())?.archivedSessionIds);
      view?.render({ ...snapshot, sessions, sessionOverview: state.sessionOverview, composerAvailable: isComposerAvailable() });
    },
  });
  view = createDashboardWorkspace({
    root: dom.homeDashboardRoot,
    passiveLearning,
    actions: {
      createJob: (templateId) =>
        schedules.createJob(
          dashboardJobInitialValues(templateId, dom.modelSelect.value),
        ),
      continueConversation: () => shell.setSessionsDrawerOpen(true),
      openJobs: () => shell.activateWorkspace("schedules"),
      refresh: controller.refresh,
      decideApproval: approvals.submit,
      openConversation: async (sessionId, requestId) => {
        try {
          if (!await openConversation(sessionId, { page: { targetRequestId: requestId } })) return;
          if (state.currentSessionId !== sessionId) return;
          if (!requestId) return;
          requestAnimationFrame(() => {
            const message = [
              ...dom.messagesList.querySelectorAll("[data-request-id]"),
            ].find((node) => node.dataset.requestId === requestId);
            message?.scrollIntoView({ block: "center", behavior: "smooth" });
          });
        } catch (error) {
          shell.showToast(
            error instanceof Error ? error.message : String(error),
            "failed",
          );
        }
      },
    },
  });
  controller.publish();
  document.addEventListener("visibilitychange", controller.visibilityChanged);
  return {
    ...controller,
    compactWidgets: view.compactWidgets,
    setActive(value) {
      view.compactWidgets.setWorkspace(value ? "home" : "other");
      controller.setActive(value);
    },
    environmentChanged() {
      view.compactWidgets.close({ restoreFocus: false });
      controller.environmentChanged();
    },
    composerHost: view.composerHost,
    setupHost: view.setupHost,
  };
}
