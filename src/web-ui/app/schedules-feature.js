import { createSchedulesController } from "./controllers/schedules-controller.js";
import { createSchedulesWorkspace } from "./components/schedules/workspace.js";

export function createSchedulesFeature({
  dom,
  client,
  shell,
  selectedEnvironmentId,
  getCurrentSessionId,
  getAgentModes,
  openSession,
}) {
  let view;
  let active = false;
  const controller = createSchedulesController({
    client,
    getEnvironmentId: selectedEnvironmentId,
    render: (snapshot) => view?.render(snapshot),
    openConversation: async (sessionId, requestId) => {
      if (!shell.activateWorkspace("chat")) return;
      if (!sessionId) return;
      try {
        await openSession(sessionId);
        if (!requestId) return;
        requestAnimationFrame(() => {
          const messages = [
            ...dom.messagesList.querySelectorAll("[data-request-id]"),
          ];
          const message = messages.find(
            (node) => node.dataset.requestId === requestId,
          );
          message?.scrollIntoView({ block: "center", behavior: "smooth" });
        });
      } catch (error) {
        shell.showToast(
          error instanceof Error ? error.message : String(error),
          "failed",
        );
      }
    },
  });
  view = createSchedulesWorkspace({
    root: dom.schedulesRoot,
    actions: controller,
    getCurrentSessionId,
    getAgentModes,
  });
  view.render(controller.snapshot());
  refreshAvailability();
  dom.environmentSelect.addEventListener("change", () => {
    queueMicrotask(() => {
      if (active) void controller.load();
    });
  });
  return {
    refreshAvailability,
    isWorkspaceAvailable(destination) {
      if (destination !== "schedules") return true;
      return client.supportsSchedules();
    },
    prepareLeave: view.prepareLeave,
    setActive(value) {
      active = value && client.supportsSchedules();
      controller.setActive(active);
    },
    openJob(jobId) {
      if (!client.supportsSchedules()) return;
      if (!shell.activateWorkspace("schedules")) return;
      void controller.openJob(jobId);
    },
    createJob(initialValues) {
      if (!client.supportsSchedules()) return;
      if (!shell.activateWorkspace("schedules")) return;
      void controller.openCreate(initialValues);
    },
  };

  function refreshAvailability() {
    const available = client.supportsSchedules();
    dom.schedulesWorkspaceButton.hidden = !available;
    dom.schedulesWorkspaceButton.disabled = !available;
    if (available) return;
    controller.setActive(false);
    if (active) shell.activateWorkspace("chat", { focus: false });
    active = false;
  }
}
