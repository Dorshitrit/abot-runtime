import {
  createInitialWorkspaceShellState,
  normalizeWorkspaceDestination,
  toggleWorkspaceSheet,
} from "../ui-behavior.js";
import { textOf } from "../lib/text-format.js";
import {
  CONVERSATION_SIDEBAR_MEDIA_QUERY,
  resolveConversationSidebarLayout,
} from "./conversation-sidebar-layout.js";
import { createOperationsSection } from "./operations-section.js";

export function createWorkspaceShell({
  dom,
  viewport = window,
  documentRoot = document,
  beforeWorkspaceChange = () => true,
}) {
  const shellState = {
    ...createInitialWorkspaceShellState(),
    toastTimer: 0,
    bound: false,
  };
  const sidebarViewport = viewport.matchMedia?.(
    CONVERSATION_SIDEBAR_MEDIA_QUERY,
  );
  const operationsSection = createOperationsSection({
    buttons: dom.operationsTabButtons,
    pages: dom.operationsTabPages,
  });

  function sidebarLayout() {
    return resolveConversationSidebarLayout(
      shellState.workspace,
      shellState.activeSheet,
      sidebarViewport?.matches === true,
    );
  }

  function setCurrentPage(button, active) {
    if (active) {
      button.setAttribute("aria-current", "page");
      return;
    }
    button.removeAttribute("aria-current");
  }

  function syncShell() {
    const chatWorkspace = shellState.workspace === "chat";
    const configWorkspace = shellState.workspace === "config";
    const sessions = sidebarLayout();
    const showSessionsToggle = chatWorkspace && !sessions.docked;

    dom.app.classList.toggle("config-workspace", configWorkspace);
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
    setCurrentPage(dom.configWorkspaceButton, configWorkspace);

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
    shellState.activeSheet = "";
    syncShell();
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
    preparedTransition.commitBeforeChange();
    const nextWorkspace = preparedTransition.nextWorkspace;
    const previousWorkspace = shellState.workspace;
    const previousSheet = shellState.activeSheet;
    shellState.workspace = nextWorkspace;
    shellState.activeSheet = "";
    syncShell();

    if (options.focus === false) return true;
    if (nextWorkspace !== "chat") {
      viewport.requestAnimationFrame(() => {
        if (shellState.workspace !== nextWorkspace) return;
        dom.closeConfigWorkspaceButton.focus();
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
    if (shellState.workspace !== "chat") {
      return activateWorkspace("chat");
    }
    return false;
  }

  function bind() {
    if (shellState.bound) return;
    shellState.bound = true;
    dom.chatWorkspaceButton.addEventListener("click", () => {
      activateWorkspace("chat");
    });
    dom.configWorkspaceButton.addEventListener("click", () => {
      activateWorkspace("config");
    });
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

  function load() {
    Object.assign(shellState, createInitialWorkspaceShellState());
    operationsSection.activateTab("runtime");
    syncShell();
  }

  return {
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
