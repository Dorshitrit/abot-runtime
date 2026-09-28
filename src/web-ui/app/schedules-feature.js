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
  onNavigationChange = () => {},
  documentRoot = globalThis.document,
  isRuntimeReady = () => true,
}) {
  let view;
  let active = false;
  let navigationRevision = 0;
  let runtimeReady = isRuntimeReady();
  const controller = createSchedulesController({
    client,
    getEnvironmentId: selectedEnvironmentId,
    onRouteSelectionChange: () => {
      navigationRevision += 1;
    },
    isVisible: isScheduleSurfaceReady,
    render: (snapshot) => {
      view?.render(snapshot);
      onNavigationChange();
    },
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
      controller.environmentChanged();
    });
  });
  documentRoot?.addEventListener(
    "visibilitychange",
    controller.visibilityChanged,
  );
  return {
    refreshAvailability,
    reconnect: () => void controller.refresh(),
    runtimeAvailabilityChanged,
    handleRealtime,
    isWorkspaceAvailable(destination) {
      if (destination !== "schedules") return true;
      return client.supportsSchedules();
    },
    prepareLeave: view.prepareLeave,
    navigationRevision: () => navigationRevision,
    selectedJobId: () => controller.snapshot().selectedId,
    setActive(value) {
      active = value && client.supportsSchedules();
      controller.setActive(active);
    },
    async openJob(jobId) {
      if (!client.supportsSchedules()) return false;
      if (!view.prepareLeave()) return false;
      if (!shell.activateWorkspace("schedules")) return false;
      await controller.openJob(jobId);
      return true;
    },
    createJob(initialValues) {
      if (!client.supportsSchedules()) return;
      if (!shell.activateWorkspace("schedules")) return;
      void controller.openCreate(initialValues);
    },
  };

  function isScheduleSurfaceReady() {
    if (documentRoot?.visibilityState === "hidden") return false;
    return isRuntimeReady();
  }

  function runtimeAvailabilityChanged() {
    const ready = isRuntimeReady();
    if (ready === runtimeReady) return;
    runtimeReady = ready;
    controller.visibilityChanged();
  }

  function isScheduleResourceChange(message) {
    if (message.type === "event")
      return [
        "scheduler.changed",
        "session.messages.updated",
        "session.title.updated",
      ].includes(message.name);
    if (message.type !== "workspace_changed") return false;
    if (!Array.isArray(message.resources)) return false;
    return message.resources.includes("sessions");
  }

  function handleRealtime(message) {
    if (!isScheduleResourceChange(message)) return;
    if (message.environment !== selectedEnvironmentId()) return;
    controller.scheduleRefresh();
  }

  function refreshAvailability() {
    const available = client.supportsSchedules();
    dom.schedulesWorkspaceButton.hidden = !available;
    dom.schedulesWorkspaceButton.disabled = !available || dom.schedulesWorkspaceButton.dataset.onboardingBlocked === "true";
    if (available) return;
    controller.setActive(false);
    if (active) shell.activateWorkspace("chat", { focus: false });
    active = false;
  }
}
