import { createDashboardWorkspace } from "./components/dashboard/workspace.js";
import { createDashboardController } from "./controllers/dashboard-controller.js";
import { dashboardJobInitialValues } from "./lib/dashboard-job-templates.js";

export function createDashboardFeature({
  dom, state, client, shell, schedules, selectedEnvironmentId,
  loadSessions, openSession, isComposerAvailable,
}) {
  let view;
  const controller = createDashboardController({
    client, getEnvironmentId: selectedEnvironmentId,
    getSessions: () => state.sessions, loadSessions,
    render: (snapshot) => view?.render({ ...snapshot, composerAvailable: isComposerAvailable() }),
  });
  view = createDashboardWorkspace({
    root: dom.homeDashboardRoot,
    actions: {
      attach: () => dom.attachmentButton.click(),
      createJob: (templateId) => schedules.createJob(dashboardJobInitialValues(templateId, dom.modelSelect.value)),
      continueConversation: () => shell.setSessionsDrawerOpen(true),
      openConfiguration: () => shell.activateWorkspace("config"),
      openJobs: () => shell.activateWorkspace("schedules"),
      refresh: controller.refresh,
      openConversation: async (sessionId, requestId) => {
        if (!shell.activateWorkspace("chat")) return;
        try {
          await openSession(sessionId);
          if (state.currentSessionId !== sessionId) return;
          if (!requestId) return;
          requestAnimationFrame(() => {
            const message = [...dom.messagesList.querySelectorAll("[data-request-id]")]
              .find((node) => node.dataset.requestId === requestId);
            message?.scrollIntoView({ block: "center", behavior: "smooth" });
          });
        } catch (error) {
          shell.showToast(error instanceof Error ? error.message : String(error), "failed");
        }
      },
    },
  });
  controller.publish();
  document.addEventListener("visibilitychange", controller.visibilityChanged);
  return { ...controller, composerHost: view.composerHost, setupHost: view.setupHost };
}
