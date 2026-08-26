import {
  focusSelectedMenuItem,
  handleMenuNavigation,
} from "../components/menu-navigation.js";
import { createWebSessionId, textOf } from "../lib/text-format.js";

export function createAppEventBindings({
  state,
  dom,
  shell,
  modelSelector,
  composerActions,
  actions,
  documentRoot = document,
}) {
  function bind() {
    dom.sessionSearchInput.addEventListener("input", () => {
      state.sessionQuery = dom.sessionSearchInput.value;
      actions.renderSessions();
    });
    dom.refreshSessionsButton.addEventListener(
      "click",
      () => void actions.loadSessions(),
    );
    dom.newSessionButton.addEventListener("click", () => {
      if (!actions.suspendQueueRecovery()) return;
      shell.activateWorkspace("chat", { focus: false });
      state.currentSessionId = createWebSessionId();
      actions.saveSessionId(
        actions.selectedEnvironmentId(),
        state.currentSessionId,
      );
      actions.rememberModelSelection();
      state.messages = [];
      actions.clearAttachments();
      actions.resetLiveRequestView();
      actions.setCurrentSessionTitle(state.currentSessionId);
      actions.applyConversationChrome();
      actions.subscribeSession(state.currentSessionId);
      actions.renderSessions();
      actions.renderMessages();
      shell.setSessionsDrawerOpen(false);
      dom.composerInput.focus();
    });
    dom.environmentSelect.addEventListener("change", () => {
      const recoveryEnvironmentId =
        state.activeComposerQueueRecovery?.scope.environmentId ?? "";
      if (!actions.suspendQueueRecovery()) {
        if (recoveryEnvironmentId)
          dom.environmentSelect.value = recoveryEnvironmentId;
        return;
      }
      state.agentPickerOpen = false;
      actions.renderAgentPicker();
      actions.saveEnvironmentId(dom.environmentSelect.value);
      state.currentSessionId = "";
      state.messages = [];
      actions.clearAttachments();
      actions.resetLiveRequestView();
      dom.sessionTitle.textContent = "New conversation";
      actions.applyConversationChrome();
      actions.renderMessages();
      void (async () => {
        await actions.loadModels();
        await Promise.allSettled([
          actions.loadAgentMode(),
          actions.loadRuntimeConfig(),
        ]);
        await actions.restoreLastSession();
      })();
    });
    dom.agentPickerButton.addEventListener("click", (event) => {
      event.stopPropagation();
      state.agentPickerOpen = !state.agentPickerOpen;
      actions.renderAgentPicker();
      if (state.agentPickerOpen) focusSelectedMenuItem(dom.agentPickerMenu);
    });
    dom.agentPickerButton.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      state.agentPickerOpen = true;
      actions.renderAgentPicker();
      focusSelectedMenuItem(
        dom.agentPickerMenu,
        event.key === "ArrowUp" ? "last" : "first",
      );
    });
    dom.agentPickerMenu.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest("[data-environment-id]");
      if (!(button instanceof HTMLButtonElement)) return;
      const nextEnvironmentId =
        button.dataset.environmentId ||
        textOf(state.config?.defaultEnvironmentId).trim() ||
        actions.configuredEnvironmentOptions()[0]?.value ||
        "";
      if (!nextEnvironmentId) return;
      if (dom.environmentSelect.value === nextEnvironmentId) {
        state.agentPickerOpen = false;
        actions.renderAgentPicker();
        return;
      }
      dom.environmentSelect.value = nextEnvironmentId;
      dom.environmentSelect.dispatchEvent(new Event("change"));
    });
    dom.agentPickerMenu.addEventListener("keydown", (event) => {
      handleMenuNavigation(event, dom.agentPickerMenu);
    });
    dom.modelSelect.addEventListener("change", () => {
      actions.rememberModelSelection();
      actions.removeUnsupportedImages();
      actions.renderAttachments();
    });
    dom.attachmentButton.addEventListener("click", () => {
      if (!dom.attachmentButton.disabled) dom.attachmentInput.click();
    });
    dom.attachmentInput.addEventListener("change", () => {
      const file = dom.attachmentInput.files?.[0];
      dom.attachmentInput.value = "";
      if (!file) return;
      void actions.uploadAttachment(file).catch((error) => {
        state.messages.push({
          id: `error-${Date.now()}`,
          role: "assistant",
          text: error instanceof Error ? error.message : String(error),
          createdAt: Date.now(),
          requestId: "",
          streaming: false,
        });
        actions.renderMessages();
      });
    });
    dom.permissionModeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      modelSelector.close();
      state.permissionModeMenuOpen = !state.permissionModeMenuOpen;
      if (state.permissionModeMenuOpen) {
        state.agentModeMenuOpen = false;
        actions.renderAgentMode();
      }
      actions.renderPermissionMode();
      if (state.permissionModeMenuOpen)
        focusSelectedMenuItem(dom.permissionModeMenu);
    });
    dom.permissionModeButton.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      modelSelector.close();
      state.permissionModeMenuOpen = true;
      state.agentModeMenuOpen = false;
      actions.renderAgentMode();
      actions.renderPermissionMode();
      focusSelectedMenuItem(
        dom.permissionModeMenu,
        event.key === "ArrowUp" ? "last" : "first",
      );
    });
    dom.permissionModeMenu.addEventListener("click", (event) =>
      event.stopPropagation(),
    );
    dom.permissionModeMenu.addEventListener("keydown", (event) => {
      handleMenuNavigation(event, dom.permissionModeMenu);
    });
    dom.agentModeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      modelSelector.close();
      state.agentModeMenuOpen = !state.agentModeMenuOpen;
      if (state.agentModeMenuOpen) {
        state.permissionModeMenuOpen = false;
        actions.renderPermissionMode();
      }
      actions.renderAgentMode();
      if (state.agentModeMenuOpen) focusSelectedMenuItem(dom.agentModeMenu);
    });
    dom.agentModeButton.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      modelSelector.close();
      state.agentModeMenuOpen = true;
      state.permissionModeMenuOpen = false;
      actions.renderPermissionMode();
      actions.renderAgentMode();
      focusSelectedMenuItem(
        dom.agentModeMenu,
        event.key === "ArrowUp" ? "last" : "first",
      );
    });
    dom.agentModeMenu.addEventListener("click", (event) =>
      event.stopPropagation(),
    );
    dom.agentModeMenu.addEventListener("keydown", (event) => {
      handleMenuNavigation(event, dom.agentModeMenu);
    });
    documentRoot.addEventListener("click", (event) => {
      if (
        !state.agentModeMenuOpen ||
        event.target === dom.agentModeButton ||
        dom.agentModeButton.contains(event.target) ||
        dom.agentModeMenu.contains(event.target)
      )
        return;
      state.agentModeMenuOpen = false;
      actions.renderAgentMode();
    });
    documentRoot.addEventListener("click", (event) => {
      if (
        !state.permissionModeMenuOpen ||
        event.target === dom.permissionModeButton ||
        dom.permissionModeButton.contains(event.target) ||
        dom.permissionModeMenu.contains(event.target)
      )
        return;
      state.permissionModeMenuOpen = false;
      actions.renderPermissionMode();
    });
    documentRoot.addEventListener("click", (event) => {
      if (
        !state.agentPickerOpen ||
        event.target === dom.agentPickerButton ||
        dom.agentPickerButton.contains(event.target) ||
        dom.agentPickerMenu.contains(event.target)
      )
        return;
      state.agentPickerOpen = false;
      actions.renderAgentPicker();
    });
    documentRoot.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      let handled = composerActions.closeMenu({ restoreFocus: true });
      if (state.agentModeMenuOpen) {
        state.agentModeMenuOpen = false;
        actions.renderAgentMode();
        dom.agentModeButton.focus();
        handled = true;
      }
      if (state.permissionModeMenuOpen) {
        state.permissionModeMenuOpen = false;
        actions.renderPermissionMode();
        dom.permissionModeButton.focus();
        handled = true;
      }
      if (state.agentPickerOpen) {
        state.agentPickerOpen = false;
        actions.renderAgentPicker();
        dom.agentPickerButton.focus();
        handled = true;
      }
      if (!handled && shell.closeOverlaysOnEscape()) handled = true;
      if (handled) event.preventDefault();
    });
    dom.composerForm.addEventListener("submit", (event) => {
      event.preventDefault();
      actions.dispatchComposerMessage(composerActions.primaryAction());
    });
    dom.composerInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      actions.dispatchComposerMessage(composerActions.primaryAction());
    });
    dom.composerInput.addEventListener("input", () => {
      actions.resizeComposer();
      actions.updateComposerSendState();
    });
    dom.refreshRuntimeButton.addEventListener(
      "click",
      () => void actions.loadRuntimeStatus(),
    );
    dom.refreshLogsButton.addEventListener(
      "click",
      () => void actions.loadRuntimeLogs(),
    );
    dom.refreshHealthButton.addEventListener(
      "click",
      () => void actions.loadSystemHealth(),
    );
  }

  return { bind };
}
