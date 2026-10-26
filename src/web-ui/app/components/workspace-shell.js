import {
  createInitialWorkspaceShellState,
  toggleWorkspaceSheet,
} from "../ui-behavior.js";
import { createOnboardingWorkspaceAccess } from "./onboarding-workspace-access.js";
import { textOf } from "../lib/text-format.js";
import {
  CONVERSATION_SIDEBAR_MEDIA_QUERY,
  resolveConversationSidebarLayout,
} from "./conversation-sidebar-layout.js";
import { createOperationsSection } from "./operations-section.js";
import { createWorkspaceTransitions } from "./workspace-transitions.js";
import { captureSessionListViewport, restoreSessionListViewport } from "./session-list-viewport.js";
import { isConfigurationWorkspace, renderConfigurationPageHeading } from "../lib/configuration-pages.js";
import { createWorkspaceRailScroll } from "./workspace-rail-scroll.js";

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
  const workspaceListeners = new Set();
  const runtimeAvailabilityListeners = new Set();
  const workspaceGuards = new Set();
  const transitions = createWorkspaceTransitions({
    getWorkspace: () => shellState.workspace,
    getNavigationRevision: () => navigationRevision,
    isAvailable: workspaceAccess.isAvailable,
    getGuards: () => [beforeWorkspaceChange, ...workspaceGuards],
  });
  function notifyWorkspaceListeners(workspace) {
    onWorkspaceChange(workspace);
    for (const listener of workspaceListeners) listener(workspace);
  }
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
    captureSessionListViewport(dom.sessionsList);
    workspaceAccess.render();
    const homeWorkspace = shellState.workspace === "home";
    const chatWorkspace = shellState.workspace === "chat";
    const configWorkspace = isConfigurationWorkspace(shellState.workspace);
    const schedulesWorkspace = shellState.workspace === "schedules";
    const automationsWorkspace = shellState.workspace === "automations";
    const learningWorkspace = shellState.workspace === "learning";
    const memoryWorkspace = shellState.workspace === "memory";
    const skillsWorkspace = shellState.workspace === "skills";
    const resourcesWorkspace = shellState.workspace === "resources";
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
    dom.app.classList.toggle("automations-workspace", automationsWorkspace);
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
    if (dom.automationsWorkspacePanel) {
      dom.automationsWorkspacePanel.hidden = !automationsWorkspace;
      dom.automationsWorkspacePanel.inert = !automationsWorkspace;
      dom.automationsWorkspacePanel.setAttribute("aria-hidden", String(!automationsWorkspace));
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
    if (dom.skillsWorkspacePanel) {
      dom.skillsWorkspacePanel.hidden = !skillsWorkspace;
      dom.skillsWorkspacePanel.inert = !skillsWorkspace;
      dom.skillsWorkspacePanel.setAttribute("aria-hidden", String(!skillsWorkspace));
    }
    setCurrentPage(dom.skillsWorkspaceButton, skillsWorkspace);
    if (dom.resourcesWorkspacePanel) {
      dom.resourcesWorkspacePanel.hidden = !resourcesWorkspace;
      dom.resourcesWorkspacePanel.inert = !resourcesWorkspace;
      dom.resourcesWorkspacePanel.setAttribute("aria-hidden", String(!resourcesWorkspace));
    }
    setCurrentPage(dom.resourcesWorkspaceButton, resourcesWorkspace);
    if (dom.notificationsWorkspacePanel) {
      dom.notificationsWorkspacePanel.hidden = !notificationsWorkspace;
      dom.notificationsWorkspacePanel.inert = !notificationsWorkspace;
      dom.notificationsWorkspacePanel.setAttribute("aria-hidden", String(!notificationsWorkspace));
    }
    setCurrentPage(dom.notificationsWorkspaceButton, notificationsWorkspace);
    dom.sessionsPanel.hidden = !sessions.visible;
    restoreSessionListViewport(dom.sessionsList);
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
    setCurrentPage(dom.automationsWorkspaceButton, automationsWorkspace);
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
    const sidebarControl = dom.sessionSearchToggleButton ?? dom.refreshSessionsButton;
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
    if (wasSessionsDrawerOpen) notifyWorkspaceListeners(shellState.workspace);
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

  function commitWorkspaceActivation(preparedTransition, options = {}) {
    if (!workspaceAccess.isAvailable(preparedTransition.nextWorkspace)) return false;
    if (!preparedTransition.commitBeforeChange()) return false;
    const nextWorkspace = preparedTransition.nextWorkspace;
    const previousWorkspace = shellState.workspace;
    const previousSheet = shellState.activeSheet;
    shellState.workspace = nextWorkspace;
    shellState.activeSheet = "";
    syncShell();
    notifyWorkspaceListeners(nextWorkspace);
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
          automations: dom.closeAutomationsWorkspaceButton,
          learning: dom.closeLearningWorkspaceButton,
          memory: dom.closeMemoryWorkspaceButton,
          skills: dom.closeSkillsWorkspaceButton,
          resources: dom.closeResourcesWorkspaceButton,
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

  async function prepareWorkspaceActivation(destination, options = {}) {
    const preparedTransition = await transitions.prepare(destination);
    if (!preparedTransition) return null;
    let committed = false;
    const activate = () => {
      if (committed) return true;
      const activated = commitWorkspaceActivation(preparedTransition, options);
      committed = activated;
      return activated;
    };
    activate.canCommit = () => committed || preparedTransition.canCommit();
    return activate;
  }

  async function activateWorkspace(destination, options = {}) {
    const preparedActivation = await prepareWorkspaceActivation(destination, options);
    return preparedActivation ? preparedActivation() : false;
  }

  function setSessionsDrawerOpen(open, options = {}) {
    if (shellState.workspace === "chat") return commitSessionsDrawer(open, options);
    return transitions.prepare("chat").then((prepared) => {
      if (!prepared?.commitBeforeChange()) return false;
      return commitSessionsDrawer(open, options);
    });
  }

  function commitSessionsDrawer(open, options) {
    const wasOpen = shellState.activeSheet === "sessions";
    shellState.workspace = "chat";
    const useDrawer = open && sidebarViewport?.matches !== true;
    shellState.activeSheet = useDrawer ? "sessions" : "";
    syncShell();
    notifyWorkspaceListeners("chat");
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
    if (["config", "models", "plugins", "schedules", "automations", "learning", "memory", "skills", "resources", "notifications"].includes(shellState.workspace)) {
      void activateWorkspace("chat");
      return true;
    }
    return false;
  }

  function bind() {
    if (shellState.bound) return;
    shellState.bound = true;
    createWorkspaceRailScroll({ rail: dom.app.querySelector?.(".workspace-rail"), documentRoot, viewport });
    dom.resourcesWorkspaceButton?.addEventListener("click", () => activateWorkspace("resources"));
    dom.closeResourcesWorkspaceButton?.addEventListener("click", () => activateWorkspace("chat"));
    dom.skillsWorkspaceButton?.addEventListener("click", () => activateWorkspace("skills"));
    dom.closeSkillsWorkspaceButton?.addEventListener("click", () => activateWorkspace("chat"));
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
    dom.automationsWorkspaceButton?.addEventListener("click", () => activateWorkspace("automations"));
    dom.closeAutomationsWorkspaceButton?.addEventListener("click", () => activateWorkspace("chat"));
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
    for (const listener of runtimeAvailabilityListeners) listener();
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
    navigationRequestRevision: transitions.requestRevision,
    subscribeRuntimeAvailabilityChange(listener) {
      runtimeAvailabilityListeners.add(listener);
      return () => runtimeAvailabilityListeners.delete(listener);
    },
    subscribeWorkspaceChange(listener) {
      workspaceListeners.add(listener);
      return () => workspaceListeners.delete(listener);
    },
    addWorkspaceGuard(guard) {
      workspaceGuards.add(guard);
      return () => workspaceGuards.delete(guard);
    },
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
