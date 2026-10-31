const terminalStatuses = new Set([
  "succeeded", "completed_with_skips", "failed", "cancelled", "interrupted", "missed",
]);

/** A read follows a visible report, never a list, preload, or background fetch. */
export function createAutomationReportReadObserver({ client, getEnvironmentId }) {
  let viewed = null;
  return {
    observe(run, visible, environmentId = getEnvironmentId()) {
      if (!visible) { viewed = null; return; }
      if (!run?.id || environmentId !== getEnvironmentId()) return;
      if (!client.supportsNotifications?.()) return;
      const phase = terminalStatuses.has(run.status) ? "finished"
        : ["running", "stopping"].includes(run.status) ? "started" : null;
      if (!phase) return;
      const key = JSON.stringify([environmentId, run.id, phase]);
      if (viewed?.key === key) return;
      const receipt = { key };
      viewed = receipt;
      // Keep report navigation usable if notification storage is unavailable.
      try {
        Promise.resolve(client.markAutomationReportRead({ runId: run.id, phase }, environmentId))
          .catch(() => { if (viewed === receipt) viewed = null; });
      } catch { if (viewed === receipt) viewed = null; }
    },
  };
}
