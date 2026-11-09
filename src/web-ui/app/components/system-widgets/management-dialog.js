import { createConfirmationDialog } from "../confirmation-dialog.js";
import { createSystemManagementSession } from "./management-session.js";
import { restoreManagementFocus } from "./management-dom.js";

let nextManagementDialog = 0;

/** A reusable trusted manager over any dashboard, outside model-generated documents. */
export function createSystemManagementDialog({ client, getEnvironmentId, documentRoot = document, onChanged = () => {} }) {
  const prefix = `system-management-${++nextManagementDialog}`;
  const dialog = documentRoot.createElement("dialog");
  dialog.className = "system-management-dialog";
  dialog.setAttribute("aria-labelledby", `${prefix}-title`);
  dialog.innerHTML = `<header class="system-management-header"><h2 id="${prefix}-title"></h2>
    <button type="button" class="system-management-close" data-system-management-close>Close</button></header>
    <div class="system-management-body" data-system-management-body></div>`;
  documentRoot.body.append(dialog);
  const title = dialog.querySelector("h2");
  const body = dialog.querySelector("[data-system-management-body]");
  const closeButton = dialog.querySelector("[data-system-management-close]");
  const confirmations = createConfirmationDialog({ documentRoot });
  let active;
  let returnFocus;
  let navigationRevision = 0;
  let leaveRevision = 0;
  let confirming = false;
  let destroyed = false;

  function isManagementAvailable(kind) {
    if (destroyed) return false;
    if (kind === "skills") return client.supportsSkills();
    if (kind === "resources") return client.supportsInformationBasket();
    return false;
  }
  function isBusy() { return Boolean(active?.session.isBusy()) || confirming; }
  function isDirty() { return Boolean(active?.session.isDirty()); }
  function updateBusy() { closeButton.disabled = isBusy(); }
  async function confirm(message, options) {
    if (!active || confirming) return false;
    const original = active;
    confirming = true;
    updateBusy();
    try {
      const accepted = await confirmations.confirm(message, options);
      return accepted && active === original && original.session.isCurrent();
    } finally { confirming = false; updateBusy(); }
  }
  function dismiss(restoreFocus) {
    const previous = active;
    active = undefined;
    confirmations.cancel();
    previous?.session.dispose();
    if (dialog.open) dialog.close();
    body.replaceChildren();
    if (restoreFocus) restoreManagementFocus(returnFocus, documentRoot);
    returnFocus = undefined;
    updateBusy();
  }
  async function prepareClose(restoreFocus) {
    const request = ++leaveRevision;
    if (!active) return true;
    if (isBusy()) return false;
    const original = active;
    const preparation = await original.session.prepareLeave();
    if (preparation === false || preparation === null) return false;
    function canCommit() {
      if (request !== leaveRevision || active !== original) return false;
      if (!original.session.isCurrent() || isBusy()) return false;
      return preparation?.canCommit?.() !== false;
    }
    if (!canCommit()) return false;
    const commit = () => {
      if (!canCommit()) return false;
      if (typeof preparation === "function" && preparation() === false) return false;
      dismiss(restoreFocus);
      return true;
    };
    commit.canCommit = canCommit;
    return commit;
  }
  async function close() {
    navigationRevision += 1;
    const preparation = await prepareClose(true);
    if (preparation === false) return false;
    return typeof preparation === "function" ? preparation() : true;
  }
  async function open(kind, { id } = {}) {
    if (!isManagementAvailable(kind)) return false;
    const request = ++navigationRevision;
    if (active?.kind === kind && active.session.isCurrent()) {
      const original = active;
      if (id && !await original.session.select(id)) return false;
      return request === navigationRevision && active === original && original.session.isCurrent();
    }
    const focus = returnFocus || documentRoot.activeElement;
    const preparation = await prepareClose(false);
    if (request !== navigationRevision || preparation === false) return false;
    if (typeof preparation === "function" && !preparation()) return false;
    if (!isManagementAvailable(kind)) return false;
    title.textContent = kind === "skills" ? "Manage Skills" : "Manage Resources";
    returnFocus = focus;
    const workspaceRoot = documentRoot.createElement("section");
    workspaceRoot.className = kind === "skills" ? "skills-workspace-panel" : "information-basket-panel";
    body.replaceChildren();
    body.append(workspaceRoot);
    const session = createSystemManagementSession({ kind, root: workspaceRoot, prefix, client, getEnvironmentId, documentRoot,
      confirm, onSnapshot: updateBusy, onChanged });
    active = { kind, session };
    try { dialog.showModal(); closeButton.focus({ preventScroll: true }); }
    catch { dismiss(true); return false; }
    return session.start(id);
  }
  closeButton.addEventListener("click", () => void close());
  dialog.addEventListener("cancel", (event) => {
    if (event.target !== dialog) return;
    event.preventDefault(); void close();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing) return;
    if (event.defaultPrevented || event.target?.closest?.("dialog") !== dialog) return;
    event.preventDefault(); event.stopPropagation(); void close();
  });
  dialog.addEventListener("close", () => {
    if (dialog.open || !active) return;
    dialog.showModal();
    void close();
  });
  return {
    open, close, isDirty, isBusy,
    isOpen: () => Boolean(active),
    prepareLeave() { navigationRevision += 1; return prepareClose(false); },
    environmentChanged() { navigationRevision += 1; leaveRevision += 1; dismiss(false); },
    handleRealtime(message) { active?.session.handleRealtime(message); },
    reconnect() { return active?.session.reconnect(); },
    visibilityChanged() { return active?.session.visibilityChanged(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      navigationRevision += 1;
      leaveRevision += 1;
      dismiss(false);
      confirmations.destroy();
      dialog.remove();
    },
  };
}
