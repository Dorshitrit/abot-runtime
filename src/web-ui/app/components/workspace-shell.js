import {
  createInitialWorkspaceShellState,
  normalizeWorkspaceDestination,
  toggleWorkspaceSheet,
  wrappedIndex,
} from "../ui-behavior.js";
import { textOf } from "../lib/text-format.js";

export function createWorkspaceShell({
  dom,
  viewport = window,
  documentRoot = document,
  beforeWorkspaceChange = () => true,
}) {
  const shellState = {
    ...createInitialWorkspaceShellState(),
    activeOperationsTab: "runtime",
    toastTimer: 0,
    bound: false,
  };

  function setCurrentPage(button, active) {
    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  }

  function syncShell() {
    const chatWorkspace = shellState.workspace === "chat";
    const operationsWorkspace = shellState.workspace === "operations";
    const configWorkspace = shellState.workspace === "config";
    const sessionsOpen = chatWorkspace && shellState.activeSheet === "sessions";

    dom.app.classList.toggle("operations-workspace", operationsWorkspace);
    dom.app.classList.toggle("config-workspace", configWorkspace);
    dom.app.classList.toggle("sessions-open", sessionsOpen);

    dom.chatPanel.hidden = !chatWorkspace;
    dom.chatPanel.inert = !chatWorkspace || sessionsOpen;
    dom.operationsWorkspacePanel.hidden = !operationsWorkspace;
    dom.operationsWorkspacePanel.inert = !operationsWorkspace;
    dom.operationsWorkspacePanel.setAttribute(
      "aria-hidden",
      operationsWorkspace ? "false" : "true",
    );
    dom.configWorkspacePanel.hidden = !configWorkspace;
    dom.configWorkspacePanel.inert = !configWorkspace;
    dom.configWorkspacePanel.setAttribute(
      "aria-hidden",
      configWorkspace ? "false" : "true",
    );

    dom.sessionsPanel.hidden = !sessionsOpen;
    dom.sessionsPanel.inert = !sessionsOpen;
    dom.sessionsPanel.setAttribute(
      "aria-hidden",
      sessionsOpen ? "false" : "true",
    );
    dom.sessionsToggleButton.setAttribute(
      "aria-expanded",
      sessionsOpen ? "true" : "false",
    );
    dom.sessionsToggleButton.setAttribute(
      "aria-label",
      sessionsOpen ? "Close conversations" : "Open conversations",
    );

    setCurrentPage(dom.chatWorkspaceButton, chatWorkspace);
    setCurrentPage(dom.operationsWorkspaceButton, operationsWorkspace);
    setCurrentPage(dom.configWorkspaceButton, configWorkspace);

    dom.panelBackdrop.classList.toggle("visible", sessionsOpen);
    dom.panelBackdrop.tabIndex = sessionsOpen ? 0 : -1;
    dom.panelBackdrop.setAttribute(
      "aria-hidden",
      sessionsOpen ? "false" : "true",
    );
  }

  function workspaceBackButton(destination) {
    return destination === "operations"
      ? dom.closeOperationsWorkspaceButton
      : dom.closeConfigWorkspaceButton;
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
      viewport.requestAnimationFrame(() =>
        workspaceBackButton(nextWorkspace)?.focus(),
      );
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
    shellState.activeSheet = open ? "sessions" : "";
    syncShell();

    if (options.focus === false) return true;
    if (open) {
      viewport.requestAnimationFrame(() => dom.closeSessionsButton?.focus());
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

  function activateOperationsTab(tabName) {
    const availableTabs = new Set(
      dom.operationsTabButtons.map((button) => textOf(button.dataset.tab)),
    );
    const normalized = textOf(tabName, "runtime") || "runtime";
    const nextTab = availableTabs.has(normalized) ? normalized : "runtime";
    shellState.activeOperationsTab = nextTab;
    for (const button of dom.operationsTabButtons) {
      const active = button.dataset.tab === nextTab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
    }
    for (const page of dom.operationsTabPages) {
      const active = page.id === `${nextTab}Tab`;
      page.classList.toggle("active", active);
      page.hidden = !active;
    }
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
    dom.operationsWorkspaceButton.addEventListener("click", () => {
      activateWorkspace("operations");
    });
    dom.configWorkspaceButton.addEventListener("click", () => {
      activateWorkspace("config");
    });
    dom.closeOperationsWorkspaceButton.addEventListener("click", () => {
      activateWorkspace("chat");
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
    for (const button of dom.operationsTabButtons) {
      button.addEventListener("click", () => {
        activateOperationsTab(button.dataset.tab);
      });
      button.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const currentIndex = dom.operationsTabButtons.indexOf(button);
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const next =
          dom.operationsTabButtons[
            wrappedIndex(currentIndex, delta, dom.operationsTabButtons.length)
          ];
        next?.focus();
        activateOperationsTab(next?.dataset.tab);
      });
    }
  }

  function load() {
    Object.assign(shellState, createInitialWorkspaceShellState());
    activateOperationsTab("runtime");
    syncShell();
  }

  return {
    activateOperationsTab,
    activateWorkspace,
    bind,
    closeOverlaysOnEscape,
    load,
    prepareWorkspaceActivation,
    setSessionsDrawerOpen,
    showToast,
  };
}
