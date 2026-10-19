/** Async run commands retain the view that authorized them through every read. */
export function createAutomationRunActions({ client, mutation, publish, loadSelected, refreshRunHistory, openRun,
  captureView }) {
  const pendingStarts = new Set();
  const runStartKey = (view) => JSON.stringify([view.environmentId, view.automationId]);
  const isStartingRun = (view = captureView()) => pendingStarts.has(runStartKey(view));

  async function openCreatedRun(result, view) {
    if (!result?.run?.id || !view.isCurrent()) return false;
    const continuation = view.captureContinuation();
    const refreshed = await loadSelected(view.automationId, "", continuation.isCurrent);
    if (!refreshed || !continuation.isCurrent()) return false;
    await refreshRunHistory(continuation.isCurrent);
    if (!continuation.isCurrent()) return false;
    return openRun(result.run.id, continuation.ownsMutation);
  }

  async function startRun() {
    const view = captureView();
    if (!view.automationId) return false;
    return createRun(view, "Run", () => client.startAutomationRun(
      view.automationId, crypto.randomUUID(), view.environmentId), "Run saved.");
  }

  async function createRun(view, label, operation, feedback) {
    if (isStartingRun(view)) return false;
    const key = runStartKey(view);
    pendingStarts.add(key);
    publish();
    try {
      const result = await mutation(label, operation, feedback, view.isCurrent);
      return await openCreatedRun(result, view);
    } finally {
      pendingStarts.delete(key);
      publish();
    }
  }

  async function stopRun() {
    const view = captureView();
    if (!view.automationId || !view.runId) return false;
    const result = await mutation("Stop request", () => client.stopAutomationRun(
      view.runId, view.environmentId), "Stop request saved.", view.isCurrent);
    if (!result || !view.isCurrent()) return false;
    return openRun(view.runId, view.captureContinuation().ownsMutation);
  }

  async function rerun() {
    const view = captureView();
    if (!view.automationId || !view.runId) return false;
    return createRun(view, "New run", () => client.rerunAutomationRun(
      view.runId, crypto.randomUUID(), view.environmentId), "New run saved.");
  }

  return { startRun, stopRun, rerun, isStartingRun };
}
