import {
  createInitialWorkspaceShellState,
  normalizeWorkspaceDestination,
  toggleWorkspaceSheet,
} from "../ui-behavior.js";
import { createOnboardingWorkspaceAccess } from "./onboarding-workspace-access.js";
import { textOf } from "../lib/text-format.js";
import {
  CONVERSATION_SIDEBAR_MEDIA_QUERY,
  resolveConversationSidebarLayout,
} from "./conversation-sidebar-layout.js";
import { createOperationsSection } from "./operations-section.js";
import { isConfigurationWorkspace, renderConfigurationPageHeading } from "../lib/configuration-pages.js";

export function createWorkspaceShell({
  dom,
  viewport = window,
  documentRoot = document,
  beforeWorkspaceChange = () => true,
  isWorkspaceAvailable = () => true,
  onWorkspaceChange = () => {},
  onNavigationChange = () => {},
}) {
  const workspaceAccess = createOnboardingWorkspaceAccess({ dom, backendAllows: isWorkspaceAvailable });
  const shellState = {
    ...createInitialWorkspaceShellState(),
    toastTimer: 0,
    bound: false,
  };
  let navigationRevision = 0;
  function noteShellNavigation() {
    navigationRevision += 1;
    onNavigationChange();
  }
  const sidebarViewport = viewport.matchMedia?.(
    CONVERSATION_SIDEBAR_MEDIA_QUERY,
  );
  const operationsSection = createOperationsSection({
    buttons: dom.operationsTabButtons,
    pages: dom.operationsTabPages,
    onNavigationChange: noteShellNavigation,
  });

  function sidebarLayout() {
    return resolveConversationSidebarLayout(
      shellState.workspace,
      shellState.activeSheet,
      sidebarViewport?.matches === true,
    );
  }

  function setCurrentPage(button, active) {
    if (!button) return;
    if (active) {
      button.setAttribute("aria-current", "page");
      return;
    }
    button.removeAttribute("aria-current");
  }

  function syncShell() {
    workspaceAccess.render();
    const homeWorkspace = shellState.workspace === "home";
    const chatWorkspace = shellState.workspace === "chat";
    const configWorkspace = isConfigurationWorkspace(shellState.workspace);
    const schedulesWorkspace = shellState.workspace === "schedules";
    const learningWorkspace = shellState.workspace === "learning";
    const memoryWorkspace = shellState.workspace === "memory";
    const notificationsWorkspace = shellState.workspace === "notifications";
    const sessions = sidebarLayout();
    const showSessionsToggle = chatWorkspace && !sessions.docked;

    dom.app.classList.toggle("config-workspace", configWorkspace);
    dom.app.classList.toggle("home-workspace", homeWorkspace);
    if (dom.homeWorkspacePanel) {
      dom.homeWorkspacePanel.hidden = !homeWorkspace;
      dom.homeWorkspacePanel.inert = !homeWorkspace;
      dom.homeWorkspacePanel.setAttribute(
        "aria-hidden",
        String(!homeWorkspace),
      );
    }
    dom.app.classList.toggle("schedules-workspace", schedulesWorkspace);
    dom.app.classList.toggle("sessions-open", sessions.drawerOpen);
    dom.app.classList.toggle("sessions-docked", sessions.docked);

    dom.chatPanel.hidden = !chatWorkspace;
    dom.chatPanel.inert = !chatWorkspace || sessions.drawerOpen;
    dom.configWorkspacePanel.hidden = !configWorkspace;
    dom.configWorkspacePanel.inert = !configWorkspace;
    dom.configWorkspacePanel.setAttribute(
      "aria-hidden",
      configWorkspace ? "false" : "true",
    );
    renderConfigurationPageHeading(dom.configWorkspacePanel, shellState.workspace);

    if (dom.schedulesWorkspacePanel) {
      dom.schedulesWorkspacePanel.hidden = !schedulesWorkspace;
      dom.schedulesWorkspacePanel.inert = !schedulesWorkspace;
      dom.schedulesWorkspacePanel.setAttribute(
        "aria-hidden",
        String(!schedulesWorkspace),
      );
    }
    dom.learningWorkspacePanel.hidden = !learningWorkspace;
    dom.learningWorkspacePanel.inert = !learningWorkspace;
    dom.learningWorkspacePanel.setAttribute(
      "aria-hidden",
      String(!learningWorkspace),
    );
    dom.memoryWorkspacePanel.hidden = !memoryWorkspace;
    dom.memoryWorkspacePanel.inert = !memoryWorkspace;
    dom.memoryWorkspacePanel.setAttribute(
      "aria-hidden",
      String(!memoryWorkspace),
    );
    if (dom.notificationsWorkspacePanel) {
      dom.notificationsWorkspacePanel.hidden = !notificationsWorkspace;
      dom.notificationsWorkspacePanel.inert = !notificationsWorkspace;
      dom.notificationsWorkspacePanel.setAttribute("aria-hidden", String(!notificationsWorkspace));
    }
    setCurrentPage(dom.notificationsWorkspaceButton, notificationsWorkspace);
    dom.sessionsPanel.hidden = !sessions.visible;
    dom.sessionsPanel.inert = !sessions.visible;
    dom.sessionsPanel.setAttribute(
      "aria-hidden",
      sessions.visible ? "false" : "true",
    );
    dom.sessionsToggleButton.setAttribute(
      "aria-expanded",
      sessions.visible ? "true" : "false",
    );
    dom.sessionsToggleButton.setAttribute(
      "aria-label",
      sessions.drawerOpen ? "Close conversations" : "Open conversations",
    );
    dom.sessionsToggleButton.hidden = !showSessionsToggle;
    dom.closeSessionsButton.hidden = sessions.docked;

    setCurrentPage(dom.chatWorkspaceButton, chatWorkspace);
    setCurrentPage(dom.homeWorkspaceButton, homeWorkspace);
    setCurrentPage(dom.configWorkspaceButton, shellState.workspace === "config");
    setCurrentPage(dom.modelsWorkspaceButton, shellState.workspace === "models");
    setCurrentPage(dom.pluginsWorkspaceButton, shellState.workspace === "plugins");
    setCurrentPage(dom.schedulesWorkspaceButton, schedulesWorkspace);
    setCurrentPage(dom.learningWorkspaceButton, learningWorkspace);
    setCurrentPage(dom.memoryWorkspaceButton, memoryWorkspace);

    dom.panelBackdrop.classList.toggle("visible", sessions.drawerOpen);
    dom.panelBackdrop.tabIndex = sessions.drawerOpen ? 0 : -1;
    dom.panelBackdrop.setAttribute(
      "aria-hidden",
      sessions.drawerOpen ? "false" : "true",
    );
  }

  function focusVisibleSessionsControl() {
    const sessions = sidebarLayout();
    if (!sessions.visible) return;
    if (sessions.drawerOpen) {
      dom.closeSessionsButton.focus();
      return;
    }
    const sidebarControl = dom.sessionSearchInput ?? dom.refreshSessionsButton;
    (sidebarControl ?? dom.chatWorkspaceButton).focus();
  }

  function sidebarFocusNeedsRestoration(activeElement, sessions) {
    if (!activeElement) return false;
    if (activeElement === dom.sessionsToggleButton) {
      return dom.sessionsToggleButton.hidden;
    }
    if (activeElement === dom.closeSessionsButton) {
      return dom.closeSessionsButton.hidden;
    }
    if (activeElement === dom.panelBackdrop) return !sessions.drawerOpen;
    if (sessions.visible) return false;
    return Boolean(activeElement.closest?.(".sessions-panel"));
  }

  function syncSidebarViewport() {
    const activeElement = documentRoot.activeElement;
    const wasSessionsDrawerOpen = shellState.activeSheet === "sessions";
    shellState.activeSheet = "";
    syncShell();
    if (wasSessionsDrawerOpen) onWorkspaceChange(shellState.workspace);
    const sessions = sidebarLayout();
    if (!sidebarFocusNeedsRestoration(activeElement, sessions)) return;
    if (sessions.docked) {
      focusVisibleSessionsControl();
      return;
    }
    const visibleNavigationButton = dom.sessionsToggleButton.hidden
      ? dom.chatWorkspaceButton
      : dom.sessionsToggleButton;
    visibleNavigationButton.focus();
  }

  function prepareWorkspaceTransition(destination) {
    const nextWorkspace = normalizeWorkspaceDestination(destination);
    if (!workspaceAccess.isAvailable(nextWorkspace)) return null;
    if (nextWorkspace === shellState.workspace) {
      return { nextWorkspace, commitBeforeChange: () => {} };
    }
    const preparedChange = beforeWorkspaceChange({
      from: shellState.workspace,
      to: nextWorkspace,
    });
    if (preparedChange === false || preparedChange === null) return null;
    return {
      nextWorkspace,
      commitBeforeChange:
        typeof preparedChange === "function" ? preparedChange : () => {},
    };
  }

  function commitWorkspaceActivation(preparedTransition, options = {}) {
    if (!workspaceAccess.isAvailable(preparedTransition.nextWorkspace)) return false;
    preparedTransition.commitBeforeChange();
    const nextWorkspace = preparedTransition.nextWorkspace;
    const previousWorkspace = shellState.workspace;
    const previousSheet = shellState.activeSheet;
    shellState.workspace = nextWorkspace;
    shellState.activeSheet = "";
    syncShell();
    onWorkspaceChange(nextWorkspace);
    noteShellNavigation();

    if (options.focus === false) return true;
    if (nextWorkspace === "home") {
      dom.composerInput?.focus();
      return true;
    }
    if (nextWorkspace !== "chat") {
      viewport.requestAnimationFrame(() => {
        if (shellState.workspace !== nextWorkspace) return;
        const closeButtons = {
          notifications: dom.closeNotificationsWorkspaceButton,
          schedules: dom.closeSchedulesWorkspaceButton,
          learning: dom.closeLearningWorkspaceButton,
          memory: dom.closeMemoryWorkspaceButton,
          config: dom.closeConfigWorkspaceButton,
          models: dom.closeConfigWorkspaceButton,
          plugins: dom.closeConfigWorkspaceButton,
        };
        closeButtons[nextWorkspace]?.focus();
      });
      return true;
    }
    if (previousWorkspace !== "chat" || previousSheet) {
      dom.chatWorkspaceButton.focus();
    }
    return true;
  }

  function prepareWorkspaceActivation(destination, options = {}) {
    const preparedTransition = prepareWorkspaceTransition(destination);
    if (!preparedTransition) return null;
    let committed = false;
    return () => {
      if (committed) return true;
      const activated = commitWorkspaceActivation(preparedTransition, options);
      committed = activated;
      return activated;
    };
  }

  function activateWorkspace(destination, options = {}) {
    const preparedActivation = prepareWorkspaceActivation(destination, options);
    return preparedActivation ? preparedActivation() : false;
  }

  function setSessionsDrawerOpen(open, options = {}) {
    const preparedTransition = prepareWorkspaceTransition("chat");
    if (!preparedTransition) return false;
    preparedTransition.commitBeforeChange();
    const wasOpen = shellState.activeSheet === "sessions";
    shellState.workspace = "chat";
    const useDrawer = open && sidebarViewport?.matches !== true;
    shellState.activeSheet = useDrawer ? "sessions" : "";
    syncShell();
    onWorkspaceChange("chat");
    noteShellNavigation();

    if (options.focus === false) return true;
    if (open) {
      viewport.requestAnimationFrame(focusVisibleSessionsControl);
      return true;
    }
    if (
      wasOpen &&
      (options.restoreFocus === true ||
        documentRoot.activeElement?.closest?.(".sessions-panel"))
    ) {
      dom.sessionsToggleButton.focus();
    }
    return true;
  }

  function toggleSessionsDrawer() {
    const next = toggleWorkspaceSheet(shellState.activeSheet, "sessions");
    setSessionsDrawerOpen(next === "sessions", {
      restoreFocus: next !== "sessions",
    });
  }

  function showToast(message, tone = "") {
    viewport.clearTimeout(shellState.toastTimer);
    dom.toastRegion.textContent = textOf(message);
    dom.toastRegion.className = `toast-region visible ${tone}`.trim();
    shellState.toastTimer = viewport.setTimeout(() => {
      dom.toastRegion.className = "toast-region";
    }, 3200);
  }

  function closeOverlaysOnEscape() {
    if (shellState.activeSheet === "sessions") {
      setSessionsDrawerOpen(false, { restoreFocus: true });
      return true;
    }
    if (["config", "models", "plugins", "schedules", "learning", "memory", "notifications"].includes(shellState.workspace)) {
      return activateWorkspace("chat");
    }
    return false;
  }

  function bind() {
    if (shellState.bound) return;
    shellState.bound = true;
    dom.notificationsWorkspaceButton?.addEventListener("click", () => activateWorkspace("notifications"));
    dom.closeNotificationsWorkspaceButton?.addEventListener("click", () => activateWorkspace("chat"));
    dom.homeWorkspaceButton?.addEventListener("click", () => {
      activateWorkspace("home");
    });
    dom.chatWorkspaceButton.addEventListener("click", () => {
      activateWorkspace("chat");
    });
    dom.configWorkspaceButton.addEventListener("click", () => {
      activateWorkspace("config");
    });
    dom.modelsWorkspaceButton?.addEventListener("click", () => activateWorkspace("models"));
    dom.pluginsWorkspaceButton?.addEventListener("click", () => activateWorkspace("plugins"));
    dom.schedulesWorkspaceButton?.addEventListener("click", () =>
      activateWorkspace("schedules"),
    );
    dom.learningWorkspaceButton.addEventListener("click", () =>
      activateWorkspace("learning"),
    );
    dom.memoryWorkspaceButton.addEventListener("click", () =>
      activateWorkspace("memory"),
    );
    dom.openMemoryRestartControlsButton?.addEventListener("click", () =>
      activateWorkspace("config"),
    );
    dom.closeLearningWorkspaceButton.addEventListener("click", () =>
      activateWorkspace("chat"),
    );
    dom.closeMemoryWorkspaceButton.addEventListener("click", () =>
      activateWorkspace("chat"),
    );
    dom.closeSchedulesWorkspaceButton?.addEventListener("click", () =>
      activateWorkspace("chat"),
    );
    dom.closeConfigWorkspaceButton.addEventListener("click", () => {
      activateWorkspace("chat");
    });
    dom.sessionsToggleButton.addEventListener("click", toggleSessionsDrawer);
    dom.closeSessionsButton.addEventListener("click", () => {
      setSessionsDrawerOpen(false, { restoreFocus: true });
    });
    dom.panelBackdrop.addEventListener("click", () => {
      if (shellState.activeSheet === "sessions") {
        setSessionsDrawerOpen(false, { restoreFocus: true });
      }
    });
    sidebarViewport?.addEventListener("change", syncSidebarViewport);
    operationsSection.bind();
  }

  function runtimeAvailabilityChanged(availability) {
    workspaceAccess.update(availability);
    if (!workspaceAccess.isAvailable(shellState.workspace))
      activateWorkspace("home", { focus: false });
  }

  function load() {
    Object.assign(shellState, createInitialWorkspaceShellState());
    operationsSection.activateTab("runtime");
    syncShell();
  }

  return {
    activeWorkspace: () => shellState.workspace,
    isWorkspaceSupportedByBackend: isWorkspaceAvailable,
    isWorkspaceAvailable: workspaceAccess.isAvailable,
    runtimeAvailabilityChanged,
    workspaceUnavailableMessage: workspaceAccess.unavailableMessage,
    navigationRevision: () => navigationRevision,
    activeOperationsTab: operationsSection.activeTab,
    activateOperationsTab: operationsSection.activateTab,
    activateWorkspace,
    bind,
    closeOverlaysOnEscape,
    load,
    prepareWorkspaceActivation,
    setSessionsDrawerOpen,
    showToast,
  };
}
