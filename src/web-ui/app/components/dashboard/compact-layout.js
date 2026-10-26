import { createHomeWidgetCard } from "./widget-card.js";
import { createHomeWidgetDialog } from "./widget-dialog.js";

export const HOME_WIDGET_MEDIA_QUERY = "(max-width: 1440px)";
const widgetOrder = ["learning", "conversations", "approvals", "activity", "automations", "resources", "computer"];

/** Home-only presentation; component owners keep their data, DOM and actions. */
export function createCompactHomeLayout({
  root, content, homeRegion = root.parentElement,
  viewport = root.ownerDocument.defaultView,
}) {
  const media = viewport?.matchMedia?.(HOME_WIDGET_MEDIA_QUERY);
  const entries = new Map();
  let enabled = false;
  let workspace = "home";
  let compact = false;
  let grid;
  let dialog;

  function canShowCompactHome() {
    if (!enabled) return false;
    return media?.matches === true;
  }

  function canOpenWidget(entry) {
    if (!compact || workspace !== "home") return false;
    return Boolean(entry?.isAvailable());
  }

  function ensureSurface() {
    if (grid || !media) return;
    grid = root.ownerDocument.createElement("div");
    grid.className = "home-widget-grid";
    grid.setAttribute("aria-label", "Home overview");
    grid.hidden = true;
    content.appendChild(grid);
    dialog = createHomeWidgetDialog({
      root,
      onClosed(entry, restoreFocus) {
        if (restoreFocus && canOpenWidget(entry)) entry.button.focus({ preventScroll: true });
      },
    });
  }

  function open(id) {
    const entry = entries.get(id);
    if (!canOpenWidget(entry)) return false;
    dialog.open(entry);
    entry.onOpen?.();
    dialog.refresh();
    return true;
  }

  function refresh() {
    for (const entry of entries.values()) {
      const available = entry.isAvailable();
      entry.button.hidden = !available;
      if (!available && dialog.isExpanded(entry.element)) dialog.close({ restoreFocus: false });
      const summary = entry.getSummary();
      entry.render(summary);
    }
    dialog?.refresh();
  }

  function reconcileViewport() {
    const next = canShowCompactHome();
    if (next === compact) return;
    const focused = root.ownerDocument.activeElement;
    const focusedEntry = [...entries.values()].find((entry) => entry.element.contains(focused) || entry.button === focused);
    const expandedEntry = [...entries.values()].find((entry) => dialog?.isExpanded(entry.element));
    dialog?.close({ restoreFocus: false });
    compact = next;
    homeRegion?.classList.toggle("home-widgets-compact", compact);
    if (grid) grid.hidden = !compact;
    refresh();
    if (!enabled || workspace !== "home") return;
    if (compact && focusedEntry?.isAvailable()) {
      focusedEntry.button.focus({ preventScroll: true });
      return;
    }
    if (compact) return;
    if (focusedEntry?.element.contains(focused) && !focusedEntry.element.hidden) {
      focused.focus({ preventScroll: true });
      return;
    }
    const returnEntry = focusedEntry || expandedEntry;
    if (returnEntry) focusDesktopContent(returnEntry);
  }

  function focusDesktopContent(entry) {
    const controls = [...entry.element.querySelectorAll("button, summary, input, textarea")];
    const control = controls.find((node) => !node.disabled && !node.closest("[hidden]"));
    const target = control || root.querySelector("textarea");
    target?.focus({ preventScroll: true });
  }

  function register({ id, label, icon = "neutral", element, getSummary,
    isAvailable = () => true, emptyMessage, onOpen, getReturnParent }) {
    if (!media || !element) return () => {};
    ensureSurface();
    const { button, render } = createHomeWidgetCard({ documentRoot: root.ownerDocument, id, label, icon });
    const entry = { id, label, element, getSummary, isAvailable, emptyMessage, onOpen, getReturnParent, button, render };
    entries.set(id, entry);
    element.classList.add("home-widget-source");
    const position = widgetOrder.indexOf(id);
    const following = [...entries.values()].find((candidate) => widgetOrder.indexOf(candidate.id) > position);
    grid.insertBefore(button, following?.button || null);
    button.addEventListener("click", () => open(id));
    refresh();
    return () => {
      if (dialog.isExpanded(element)) dialog.close({ restoreFocus: false });
      element.classList.remove("home-widget-source");
      button.remove();
      entries.delete(id);
    };
  }

  media?.addEventListener("change", reconcileViewport);
  return {
    register, refresh, open,
    isExpanded: (element) => dialog?.isExpanded(element) === true,
    close: (options) => dialog?.close(options),
    setEnabled(value) { enabled = value; reconcileViewport(); },
    setWorkspace(value) {
      workspace = value;
      if (value !== "home") dialog?.close({ restoreFocus: false });
    },
    dispose() {
      dialog?.dispose();
      for (const entry of entries.values()) entry.element.classList.remove("home-widget-source");
      entries.clear();
      grid?.remove();
      homeRegion?.classList.remove("home-widgets-compact");
      media?.removeEventListener("change", reconcileViewport);
    },
  };
}
