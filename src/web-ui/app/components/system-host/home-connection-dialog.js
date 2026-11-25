import { createHomeWidgetDialog } from "../dashboard/widget-dialog.js";

/** The connection manager stays mounted; its live surface is borrowed only while open. */
export function createComputerConnectionDialog({
  root, homeRegion, source, button, canOpen, getSummary, onOpen, closeShared,
}) {
  const documentRoot = root.ownerDocument;
  const Observer = documentRoot.defaultView?.MutationObserver;
  let dialog;
  function close(options = {}) { dialog?.close(options); }
  function sync() {
    if (!canOpen()) close({ restoreFocus: false });
  }
  function canRestoreCardFocus() {
    if (!canOpen()) return false;
    let node = button;
    while (node) {
      if (node.hidden) return false;
      node = node.parentElement;
    }
    return true;
  }
  function open() {
    if (!canOpen()) return false;
    closeShared();
    if (!dialog) dialog = createHomeWidgetDialog({
      root, titleId: "home-computer-detail-title",
      onClosed(_entry, restoreFocus) {
        if (restoreFocus && canRestoreCardFocus()) button.focus({ preventScroll: true });
      },
    });
    dialog.open({ id: "computer", label: "Computer access", element: source, button, getSummary }, { host: homeRegion || root });
    onOpen();
    dialog.refresh();
    return true;
  }
  const observer = Observer ? new Observer(sync) : null;
  if (homeRegion) observer?.observe(homeRegion, { attributes: true, attributeFilter: ["hidden"] });
  documentRoot.addEventListener?.("visibilitychange", sync);
  const pageHidden = () => close({ restoreFocus: false });
  documentRoot.defaultView?.addEventListener?.("pagehide", pageHidden);
  return {
    open, close, sync,
    refresh() { sync(); dialog?.refresh(); },
    dispose() {
      dialog?.dispose();
      observer?.disconnect();
      documentRoot.removeEventListener?.("visibilitychange", sync);
      documentRoot.defaultView?.removeEventListener?.("pagehide", pageHidden);
    },
  };
}
