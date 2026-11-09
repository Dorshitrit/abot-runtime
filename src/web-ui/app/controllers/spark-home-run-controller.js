const terminalStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);
export function isActiveSparkHomeRun(run) { return Boolean(run && !terminalStatuses.has(run.status)); }
function isOlderSparkHomeRun(current, incoming) {
  if (!current || !incoming || current.runId !== incoming.runId) return false;
  return incoming.revision < current.revision;
}

function sparkHomeActionError(error) {
  const messages = {
    spark_home_run_busy: "A HOME request is already active. Check its progress before starting another.",
    spark_home_settings_stale: "HOME settings changed. Reload HOME before requesting a screen.",
    spark_home_settings_conflict: "HOME settings changed. Reload HOME before requesting a screen.",
    spark_home_model_required: "Choose and save an EA model in HOME settings first.",
    spark_home_model_unavailable: "The saved HOME model is unavailable. Choose another EA model in HOME settings.",
    spark_home_execution_agent_required: "HOME requires a saved EA model. Update HOME settings first.",
    spark_home_calibration_required: "Save a personal direction in HOME settings before creating a screen.",
    spark_home_approval_not_pending: "This approval is no longer waiting. HOME status is being checked.",
  };
  return messages[error?.code || error?.message] || "The HOME action could not be confirmed. Check its status before trying again.";
}

/** Observes the HOME owner only. It never submits, resumes or fabricates a chat request. */
export function createSparkHomeRunController({ client, getEnvironmentId, isAvailable, render, onPublished,
  setTimer = setTimeout, clearTimer = clearTimeout, pollMs = 2000 }) {
  const state = { environmentId: getEnvironmentId(), run: null, busy: false, connected: true, error: "" };
  let generation = 0;
  let watching = false;
  let timer;
  let pendingRead;
  let publishedRevision = null;
  let readError = "";
  const snapshot = () => ({ ...state, error: state.error || readError });
  const publish = () => render(snapshot());
  function ownsOperation(environment, revision) {
    if (environment !== state.environmentId || environment !== getEnvironmentId()) return false;
    return revision === generation;
  }
  function scheduleRead() {
    clearTimer(timer); timer = undefined;
    if (!isAvailable()) return;
    if (!watching && !isActiveSparkHomeRun(state.run)) return;
    timer = setTimer(() => void refresh(), pollMs);
  }
  function acceptRun(run) {
    if (isOlderSparkHomeRun(state.run, run)) return;
    if (run && (run.runId !== state.run?.runId || run.revision > state.run.revision)) state.error = "";
    state.run = run;
    state.connected = true; readError = "";
    if (run?.status === "completed" && run.screenRevision !== publishedRevision) {
      publishedRevision = run.screenRevision;
      onPublished(run);
    }
    publish();
  }
  async function refresh() {
    if (!isAvailable()) { state.connected = false; publish(); return; }
    if (pendingRead) return pendingRead;
    const environment = state.environmentId;
    const revision = generation;
    const read = Promise.resolve().then(async () => {
      try {
        const result = await client.getSparkHomeRun({}, environment);
        if (ownsOperation(environment, revision)) acceptRun(result.run);
      } catch {
        if (ownsOperation(environment, revision)) {
          state.connected = false;
          readError = "HOME status could not be checked. Your run may still be active.";
          publish();
        }
      } finally {
        if (pendingRead === read) pendingRead = undefined;
        if (ownsOperation(environment, revision)) scheduleRead();
      }
    });
    pendingRead = read;
    return read;
  }
  async function act(action, input) {
    if (state.busy || !isAvailable()) return false;
    const environment = state.environmentId;
    const revision = ++generation;
    pendingRead = undefined;
    state.busy = true; state.error = ""; publish();
    try {
      const result = await action(input, environment);
      if (!ownsOperation(environment, revision)) return false;
      acceptRun(result.run);
      return true;
    } catch (error) {
      if (ownsOperation(environment, revision)) {
        state.error = sparkHomeActionError(error);
        publish();
      }
      return false;
    } finally {
      if (ownsOperation(environment, revision)) {
        state.busy = false; publish();
        void refresh();
      }
    }
  }
  return {
    snapshot, refresh,
    setWatching(value) { watching = value; if (value) void refresh(); else scheduleRead(); },
    start(expectedSettingsRevision) {
      if (isActiveSparkHomeRun(state.run)) return Promise.resolve(false);
      return act(client.startSparkHomeRun, { expectedSettingsRevision });
    },
    cancel() {
      if (!isActiveSparkHomeRun(state.run)) return Promise.resolve(false);
      return act(client.cancelSparkHomeRun, { runId: state.run.runId });
    },
    decide(approvalId, approved, reason) {
      if (state.run?.status !== "awaiting_approval") return Promise.resolve(false);
      if (state.run.pendingApproval?.approvalId !== approvalId) return Promise.resolve(false);
      return act(client.decideSparkHomeApproval, { runId: state.run.runId, approvalId, approved, ...(reason ? { reason } : {}) });
    },
    environmentChanged() {
      if (state.environmentId === getEnvironmentId()) return refresh();
      generation += 1; clearTimer(timer); pendingRead = undefined; publishedRevision = null; readError = "";
      Object.assign(state, { environmentId: getEnvironmentId(), run: null, busy: false, connected: true, error: "" });
      publish(); return refresh();
    },
    dispose() { generation += 1; watching = false; clearTimer(timer); pendingRead = undefined; },
  };
}
