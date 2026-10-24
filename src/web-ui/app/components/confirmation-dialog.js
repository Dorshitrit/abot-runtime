const dialogs = new WeakMap();
let nextDialogId = 0;

/** Shared, non-blocking confirmation. Overlapping requests fail closed. */
export function createConfirmationDialog({ documentRoot = globalThis.document } = {}) {
  const dialog = documentRoot.createElement("dialog");
  const id = `confirmation-${++nextDialogId}`;
  dialog.className = "confirmation-dialog";
  dialog.setAttribute("aria-labelledby", `${id}-title`);
  dialog.setAttribute("aria-describedby", `${id}-description`);
  dialog.innerHTML = `<div class="confirmation-content">
    <header class="confirmation-heading"><h2 id="${id}-title"></h2>
      <button type="button" class="confirmation-close" aria-label="Close confirmation">×</button></header>
    <p id="${id}-description" class="confirmation-description"></p>
    <footer class="confirmation-actions"><button type="button" data-confirmation-cancel>Cancel</button>
      <button type="button" data-confirmation-accept>Continue</button></footer>
  </div>`;
  documentRoot.body.append(dialog);
  const heading = dialog.querySelector("h2");
  const description = dialog.querySelector(".confirmation-description");
  const cancel = dialog.querySelector("[data-confirmation-cancel]");
  const accept = dialog.querySelector("[data-confirmation-accept]");
  let pending;
  let returnFocus;
  let destroyed = false;

  function finish(approved) {
    if (!pending) return;
    const resolve = pending;
    pending = undefined;
    if (dialog.open) dialog.close();
    if (returnFocus?.isConnected && !returnFocus.closest("[hidden], [inert]")) returnFocus.focus();
    returnFocus = undefined;
    resolve(approved);
  }
  cancel.addEventListener("click", () => finish(false));
  dialog.querySelector(".confirmation-close").addEventListener("click", () => finish(false));
  accept.addEventListener("click", () => finish(true));
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    finish(false);
  });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); });
  // A delayed close event from the previous request must not cancel a newly opened one.
  dialog.addEventListener("close", () => { if (!dialog.open) finish(false); });
  const onPageHide = () => finish(false);
  documentRoot.defaultView?.addEventListener("pagehide", onPageHide);

  return {
    confirm(message, { title = "Confirm action", confirmLabel = "Continue", tone = "default" } = {}) {
      if (pending || destroyed) return Promise.resolve(false);
      heading.textContent = title;
      description.textContent = message;
      accept.textContent = confirmLabel;
      dialog.dataset.tone = tone === "danger" ? "danger" : "default";
      returnFocus = documentRoot.activeElement;
      return new Promise((resolve) => {
        pending = resolve;
        try {
          dialog.showModal();
          cancel.focus();
        } catch {
          finish(false);
        }
      });
    },
    cancel() { finish(false); },
    destroy() {
      destroyed = true;
      finish(false);
      documentRoot.defaultView?.removeEventListener("pagehide", onPageHide);
      dialog.remove();
    },
  };
}

export function confirmDialog(message, options) {
  const documentRoot = globalThis.document;
  if (!documentRoot?.body) return Promise.resolve(false);
  let instance = dialogs.get(documentRoot);
  if (!instance) {
    instance = createConfirmationDialog({ documentRoot });
    dialogs.set(documentRoot, instance);
  }
  return instance.confirm(message, options);
}
