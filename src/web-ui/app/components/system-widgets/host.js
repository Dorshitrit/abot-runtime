import { createSystemWidgetsController } from "../../controllers/system-widgets-controller.js";
import { confirmKnowledgeCandidateAction } from "../passive-learning/candidate-actions.js";
import { createSystemManagementDialog } from "./management-dialog.js";
import { renderSystemWidget, SYSTEM_WIDGET_HEIGHTS } from "./cards.js";
import { normalizeRealtimeMessage } from "../../lib/realtime-message.js";
import { createConfirmationDialog } from "../confirmation-dialog.js";
import { createDashboardSystemWidgetMounts, isDashboardSystemWidget } from "./dashboard-mounts.js";
import { createSystemMetricsMounts } from "./metrics-mounts.js";

/** Reusable native widget owner: ordinary Dashboard and HOME can supply their own mount roots. */
export function createSystemWidgets({ client, getEnvironmentId, isAvailable = () => true, documentRoot = document,
  onConfigureSpark = () => {}, dashboardWidgets }) {
  const mounted = new Set();
  let environmentId = getEnvironmentId();
  let active = false;
  let confirming = false;
  let controller;
  const confirmations = createConfirmationDialog({ documentRoot });
  const dashboard = createDashboardSystemWidgetMounts({ registry: dashboardWidgets, getEnvironmentId, isAvailable });
  const metrics = createSystemMetricsMounts({ client, getEnvironmentId, isAvailable, documentRoot });
  const management = createSystemManagementDialog({ client, getEnvironmentId, documentRoot,
    onChanged: () => void controller?.refresh() });
  controller = createSystemWidgetsController({ client, getEnvironmentId, isAvailable,
    render: state => { for (const view of mounted) view.render(state); } });
  function updateSources() { controller.setWidgets([...mounted].map(view => view.id)); }
  function mount(root, id, onHeight = () => {}) {
    if (!Object.hasOwn(SYSTEM_WIDGET_HEIGHTS, id)) return { dispose() {} };
    if (id === "system-metrics") return metrics.mount(root, onHeight);
    if (isDashboardSystemWidget(id)) return dashboard.mount(root, id, onHeight);
    let page = 0;
    let markup = null;
    let height;
    let disposed = false;
    const view = { id, render(state) {
      const next = renderSystemWidget(id, state, page);
      if (next !== markup) { root.innerHTML = next; markup = next; }
      const nextHeight = next ? SYSTEM_WIDGET_HEIGHTS[id] : 0;
      if (nextHeight !== height) { height = nextHeight; onHeight(height); }
    } };
    async function click(event) {
      const button = event.target.closest?.("button");
      if (!active || disposed || !button || !root.contains(button) || button.disabled) return;
      const state = controller.snapshot();
      if (button.dataset.candidateAction) {
        const candidate = state.candidates.find(item => item.id === button.dataset.candidateId && item.revision === Number(button.dataset.candidateRevision));
        if (!candidate) return;
        if (confirming) return;
        confirming = true;
        try {
          await confirmKnowledgeCandidateAction({ candidate, action: button.dataset.candidateAction,
            environmentId: state.environmentId, actions: controller, confirm: confirmations.confirm,
            isCurrent: () => !disposed && active && getEnvironmentId() === state.environmentId
              && controller.snapshot().candidates.some(item => item.id === candidate.id && item.revision === candidate.revision) });
        } finally { confirming = false; }
        return;
      }
      const name = button.dataset.widgetAction;
      if (name === "refresh") return controller.refresh();
      if (name === "previous") { page = Math.max(0, page - 1); view.render(state); return; }
      if (name === "next") { page = Math.min(page + 1, Math.max(0, Math.ceil(state.candidates.length / 5) - 1)); view.render(state); return; }
      if (name === "skills" || name === "skill") return management.open("skills", { id: button.dataset.widgetItem });
      if (name === "resources" || name === "resource") return management.open("resources", { id: button.dataset.widgetItem });
      if (name === "spark-settings") return onConfigureSpark();
    }
    root.addEventListener("click", click);
    mounted.add(view); view.render(controller.snapshot()); updateSources();
    function dispose() {
      if (disposed) return;
      disposed = true; confirmations.cancel(); mounted.delete(view); root.removeEventListener("click", click); root.replaceChildren(); updateSources();
    }
    view.dispose = dispose;
    return { dispose };
  }
  return {
    mount, refresh: controller.refresh,
    setActive(value) { active = value; controller.setActive(value); dashboard.setActive(value); metrics.setActive(value); },
    prepareLeave() {
      if (confirming || controller.snapshot().pendingCandidateId) return Promise.resolve(false);
      return management.prepareLeave();
    },
    isDirty: management.isDirty, isBusy: () => confirming || Boolean(controller.snapshot().pendingCandidateId) || management.isBusy(),
    environmentChanged() {
      metrics.environmentChanged();
      dashboard.environmentChanged();
      if (environmentId === getEnvironmentId() && isAvailable()) { void controller.refresh(); return; }
      environmentId = getEnvironmentId(); confirmations.cancel(); management.environmentChanged(); controller.environmentChanged();
    },
    handleRealtime(raw) {
      const message = normalizeRealtimeMessage(raw);
      management.handleRealtime(message);
      if ((message.environmentId || message.environment) !== getEnvironmentId()) return;
      if (message.type === "learning.changed") { void controller.refresh(); return; }
      if (message.type === "workspace_changed" && message.resources?.includes("information-basket")) void controller.refresh();
    },
    reconnect() { metrics.reconnect(); management.reconnect(); void controller.refresh(); },
    visibilityChanged() { metrics.visibilityChanged(); management.visibilityChanged(); if (documentRoot.visibilityState !== "hidden") void controller.refresh(); },
    destroy() {
      active = false; controller.setActive(false);
      dashboard.destroy();
      metrics.destroy();
      for (const view of mounted) view.dispose();
      controller.environmentChanged(); confirmations.destroy(); management.destroy();
    },
  };
}
