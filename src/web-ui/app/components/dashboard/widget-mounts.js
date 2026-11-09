import { createHomeWidgetCard } from "./widget-card.js";

const mountableWidgets = new Set(["learning", "conversations", "approvals", "activity", "automations", "computer"]);
const widgetHeight = 200;

/** Additional previews share the registered live panels and their existing data owners. */
export function createDashboardWidgetMounts({ getEntry, canUseDashboardWidgetHost, open, close, isExpanded }) {
  const mounted = new Map();
  function mount(root, id, onHeight = () => {}) {
    if (!mountableWidgets.has(id) || mounted.has(id)) {
      onHeight(0);
      return { setActive() {}, dispose() {} };
    }
    let active = false;
    let disposed = false;
    let card;
    let entry;
    let height;
    function canOpenMountedDashboardWidget() {
      if (disposed || !active || !canUseDashboardWidgetHost()) return false;
      return Boolean(getEntry(id)?.isAvailable());
    }
    function closeOwnedDialog() {
      if (entry && card) close(entry.element, card.button);
    }
    function activate() {
      if (!canOpenMountedDashboardWidget()) return;
      const current = getEntry(id);
      open({ ...current, button: card.button, canRestoreFocus: canOpenMountedDashboardWidget });
    }
    function publishHeight(next) {
      if (height === next) return;
      height = next;
      onHeight(next);
    }
    function refresh() {
      if (disposed) return;
      const current = getEntry(id);
      if (!current?.isAvailable()) {
        closeOwnedDialog();
        if (card) card.button.hidden = true;
        publishHeight(0);
        return;
      }
      entry = current;
      if (!card) {
        card = createHomeWidgetCard({ documentRoot: root.ownerDocument, id, label: entry.label, icon: entry.icon });
        card.button.classList.add("home-widget-mounted");
        card.button.addEventListener("click", activate);
        root.appendChild(card.button);
      }
      card.button.hidden = false;
      card.button.disabled = !canOpenMountedDashboardWidget();
      if (!canOpenMountedDashboardWidget()) closeOwnedDialog();
      card.render(entry.getSummary());
      publishHeight(widgetHeight);
    }
    function dispose() {
      if (disposed) return;
      closeOwnedDialog();
      disposed = true;
      card?.button.removeEventListener("click", activate);
      card?.button.remove();
      mounted.delete(id);
    }
    const view = { refresh, dispose, isExpanded: () => Boolean(entry && card && isExpanded(entry.element, card.button)),
      setActive(value) { active = Boolean(value); refresh(); } };
    mounted.set(id, view);
    refresh();
    return { setActive: view.setActive, dispose };
  }
  return {
    mount,
    refresh() { for (const view of mounted.values()) view.refresh(); },
    isExpanded: () => [...mounted.values()].some(view => view.isExpanded()),
    dispose() { for (const view of [...mounted.values()]) view.dispose(); },
  };
}
