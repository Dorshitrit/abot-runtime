import { createWorkspaceConversationOpener } from "./controllers/workspace-conversation-opener.js";
import { createSchedulesController } from "./controllers/schedules-controller.js";
import { createSchedulesWorkspace } from "./components/schedules/workspace.js";

export function createSchedulesFeature({
  dom,
  state = {},
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
  const openConversation = createWorkspaceConversationOpener({ state, shell, openSession });
  let view;
  let active = false;
  let navigationRevision = 0;
  let navigationRequest = 0;
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
      try {
        if (!await openConversation(sessionId, { page: { targetRequestId: requestId } })) return;
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
    getEnvironmentId: selectedEnvironmentId,
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
    prepareLeave: view.prepareEnvironmentChange,
    prepareEnvironmentChange: view.prepareEnvironmentChange,
    navigationRevision: () => navigationRevision,
    selectedJobId: () => controller.snapshot().selectedId,
    setActive(value) {
      active = value && client.supportsSchedules();
      controller.setActive(active);
    },
    async openJob(jobId) {
      if (!client.supportsSchedules()) return false;
      if (!await commitScheduleNavigation()) return false;
      await controller.openJob(jobId);
      return true;
    },
    async createJob(initialValues) {
      if (!client.supportsSchedules()) return;
      if (!await commitScheduleNavigation()) return;
      void controller.openCreate(initialValues);
    },
  };

  async function commitScheduleNavigation() {
    const request = ++navigationRequest;
    const environment = selectedEnvironmentId();
    const revision = navigationRevision;
    const workspaceRequest = shell.navigationRequestRevision?.();
    const preparedDiscard = await view.prepareEnvironmentChange();
    if (!preparedDiscard) return false;
    if (!isCurrentScheduleNavigation()) return false;
    if (workspaceRequest !== shell.navigationRequestRevision?.()) return false;
    const activate = await shell.prepareWorkspaceActivation("schedules");
    if (!activate || !isCurrentScheduleNavigation()) return false;
    if (activate.canCommit?.() === false) return false;
    if (!preparedDiscard()) return false;
    return activate();
    function isCurrentScheduleNavigation() {
      if (request !== navigationRequest) return false;
      if (environment !== selectedEnvironmentId()) return false;
      if (revision !== navigationRevision) return false;
      return preparedDiscard.canCommit() !== false;
    }
  }

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
