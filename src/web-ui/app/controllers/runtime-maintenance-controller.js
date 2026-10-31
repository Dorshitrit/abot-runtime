import { runtimeMaintenanceConfirmation, runtimeMaintenanceError, runtimeMaintenanceOutcome } from "../lib/runtime-maintenance-presentation.js";

function hasMaintenanceAction(action) {
  return action === "sessions" || action === "logs";
}

/** Confirmation binds to one environment revision, never the later selection. */
export function createRuntimeMaintenanceController({
  client, getEnvironmentId, confirmAction, render = () => {},
  onSessionsReset = async () => {}, onLogsReset = async () => {},
}) {
  let environmentId = getEnvironmentId();
  let revision = 0;
  let pending = false;
  let message = "";
  let failed = false;

  function supportsMaintenance() {
    return client.supportsRuntimeMaintenance?.() === true;
  }
  function snapshot() {
    return { environmentId, pending, message, failed, available: supportsMaintenance() };
  }
  function environmentChanged() {
    const selected = getEnvironmentId();
    if (selected !== environmentId) {
      environmentId = selected;
      revision += 1;
      message = "";
      failed = false;
    }
    render(snapshot());
  }
  function isCurrentConfirmation(scope, capturedRevision) {
    if (scope !== getEnvironmentId()) return false;
    if (capturedRevision !== revision) return false;
    return supportsMaintenance();
  }
  async function perform(action, scope) {
    if (action === "sessions") return client.resetRuntimeSessions(scope);
    return client.clearRuntimeLogs(scope);
  }
  async function reconcile(action, result, scope) {
    if (action === "sessions") return onSessionsReset(result, scope);
    return onLogsReset(result, scope);
  }
  async function reset(action) {
    if (!hasMaintenanceAction(action)) return;
    if (pending) return;
    environmentChanged();
    if (!supportsMaintenance()) return;
    const scope = environmentId;
    if (!scope) return;
    const capturedRevision = revision;
    pending = true;
    message = "";
    failed = false;
    render(snapshot());
    try {
      const { message: warning, ...options } = runtimeMaintenanceConfirmation(action, scope);
      if (!await confirmAction(warning, options)) return;
      if (!isCurrentConfirmation(scope, capturedRevision)) return;
      message = action === "sessions" ? "Deleting sessions and uploaded files…" : "Deleting runtime logs…";
      render(snapshot());
      const payload = await perform(action, scope);
      const result = payload.result;
      if (action === "logs" && !isCurrentConfirmation(scope, capturedRevision)) return;
      if (isCurrentConfirmation(scope, capturedRevision)) {
        message = runtimeMaintenanceOutcome(action, result);
        failed = result.complete !== true;
        render(snapshot());
      }
      try { await reconcile(action, result, scope); }
      catch {
        if (!isCurrentConfirmation(scope, capturedRevision)) return;
        message += " The page could not refresh all local views. Refresh the page to see the saved result.";
        failed = true;
      }
    } catch (error) {
      if (!isCurrentConfirmation(scope, capturedRevision)) return;
      message = runtimeMaintenanceError(error);
      failed = true;
    } finally {
      pending = false;
      environmentChanged();
    }
  }
  function reportRefreshFailure(scope) {
    if (scope !== getEnvironmentId()) return;
    message = "Sessions were reset, but some views could not refresh. Refresh the page to see the saved result.";
    failed = true;
    render(snapshot());
  }
  return { reset, environmentChanged, snapshot, reportRefreshFailure };
}
