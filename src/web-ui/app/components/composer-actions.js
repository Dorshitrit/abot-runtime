import { resolveComposerPrimaryAction } from "../ui-behavior.js";

export function createComposerActions({
  dom,
  onSendNext,
  documentRoot = document,
}) {
  let menuOpen = false;
  let primaryAction = "send";
  let splitAvailable = false;

  function closeMenu({ restoreFocus = false } = {}) {
    if (!menuOpen) return false;
    menuOpen = false;
    renderMenu();
    if (restoreFocus) dom.sendNextMenuButton.focus();
    return true;
  }

  function renderMenu() {
    dom.sendNextMenuButton.setAttribute(
      "aria-expanded",
      menuOpen ? "true" : "false",
    );
    dom.sendNextMenuButton.classList.toggle("open", menuOpen);
    dom.sendNextMenu.classList.toggle("open", menuOpen);
    dom.sendNextMenu.hidden = !menuOpen;
  }

  function render({
    activeRequestId,
    attachmentCount = 0,
    busy = false,
    disabled = false,
    queuedCount = 0,
  }) {
    const requestActive = Boolean(String(activeRequestId || "").trim());
    const hasAttachments = Number(attachmentCount) > 0;
    primaryAction = resolveComposerPrimaryAction(
      activeRequestId,
      attachmentCount,
    );
    splitAvailable = requestActive && !hasAttachments;
    const interactionDisabled = busy || disabled;
    if (!splitAvailable || interactionDisabled) menuOpen = false;

    const labels = {
      send: "Send",
      steer: "Steer current request",
      send_next: "Send next",
    };
    const label = labels[primaryAction];
    dom.composerForm.classList.toggle(
      "composer-has-split-action",
      splitAvailable,
    );
    dom.composerSubmitControl.classList.toggle("split", splitAvailable);
    dom.sendButton.dataset.action = primaryAction;
    dom.sendButton.title = label;
    dom.sendButton.setAttribute("aria-label", label);
    dom.sendButtonLabel.textContent = label;
    dom.sendButton.disabled = interactionDisabled;
    dom.sendNextMenuButton.hidden = !splitAvailable;
    dom.sendNextMenuButton.disabled = interactionDisabled;
    const menuLabel =
      queuedCount > 0
        ? `More send options, ${queuedCount} queued`
        : "More send options";
    dom.sendNextMenuButton.title = menuLabel;
    dom.sendNextMenuButton.setAttribute("aria-label", menuLabel);
    if (queuedCount > 0) {
      dom.sendNextMenuButton.dataset.count = String(queuedCount);
    } else {
      delete dom.sendNextMenuButton.dataset.count;
    }
    dom.sendNextButton.disabled = interactionDisabled;
    dom.sendNextButton.textContent =
      queuedCount > 0 ? `Send next (${queuedCount} queued)` : "Send next";
    renderMenu();
  }

  function bind() {
    dom.sendNextMenuButton.addEventListener("click", () => {
      if (!splitAvailable || dom.sendNextMenuButton.disabled) return;
      menuOpen = !menuOpen;
      renderMenu();
      if (menuOpen) dom.sendNextButton.focus();
    });
    dom.sendNextButton.addEventListener("click", () => {
      if (dom.sendNextButton.disabled) return;
      closeMenu();
      onSendNext();
    });
    documentRoot.addEventListener("click", (event) => {
      if (
        !menuOpen ||
        event.target === dom.sendNextMenuButton ||
        dom.sendNextMenuButton.contains(event.target) ||
        dom.sendNextMenu.contains(event.target)
      ) {
        return;
      }
      closeMenu();
    });
    documentRoot.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !menuOpen) return;
      event.preventDefault();
      closeMenu({ restoreFocus: true });
    });
  }

  return Object.freeze({
    bind,
    closeMenu,
    primaryAction: () => primaryAction,
    render,
  });
}
