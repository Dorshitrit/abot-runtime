import { workspaceQueue } from "./services/workspace-state.js";
import { confirmDialog } from "./components/confirmation-dialog.js";
import { createRuntimeMaintenanceView } from "./components/runtime-maintenance.js";
import { createRuntimeMaintenanceController } from "./controllers/runtime-maintenance-controller.js";

export function createRuntimeMaintenanceFeature({ root, client, getEnvironmentId, onSessionsReset, onLogsReset }) {
  if (!root) return { environmentChanged() {}, setCompanionResetHandler() {}, observeRealtimeMessage() {} };
  let view;
  let companionReset;
  const receipts = new Map();
  async function applyReset(result, environmentId) {
    const outcomes = await Promise.allSettled([workspaceQueue()?.refresh()]);
    outcomes.push(...await Promise.allSettled([onSessionsReset, companionReset].map((handler) =>
      Promise.resolve().then(() => handler?.(result, environmentId)))));
    if (outcomes.some((outcome) => outcome.status === "rejected")) throw new Error("runtime_reset_view_refresh_failed");
  }
  function reconcileSessions(result, environmentId) {
    const key = result.resetId ? `${environmentId}:${result.resetId}` : null;
    if (key && receipts.has(key)) return receipts.get(key);
    const pending = applyReset(result, environmentId);
    if (key) {
      receipts.set(key, pending);
      if (receipts.size > 100) receipts.delete(receipts.keys().next().value);
    }
    return pending;
  }
  async function observeRealtimeMessage(message) {
    if (message.type !== "workspace_changed") return;
    const result = message.sessionReset;
    const environmentId = message.environment;
    if (typeof environmentId !== "string" || !environmentId) return;
    if (typeof result?.resetId !== "string" || !result.resetId) return;
    if (![result.deletedSessionIds, result.clearedSessionIds].every((ids) =>
      Array.isArray(ids) && ids.every((id) => typeof id === "string"))) return;
    try { await reconcileSessions(result, environmentId); }
    catch { controller.reportRefreshFailure(environmentId); }
  }
  const controller = createRuntimeMaintenanceController({
    client, getEnvironmentId, confirmAction: confirmDialog, onSessionsReset: reconcileSessions, onLogsReset,
    render: (snapshot) => view?.render(snapshot),
  });
  view = createRuntimeMaintenanceView(root, controller.reset);
  controller.environmentChanged();
  return { ...controller, observeRealtimeMessage, setCompanionResetHandler(handler) { companionReset = handler; } };
}
