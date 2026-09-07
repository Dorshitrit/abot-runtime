export function createDashboardController({
  client,
  getEnvironmentId,
  getSessions,
  loadSessions,
  render,
  isVisible = () => document.visibilityState === "visible",
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const state = {
    runs: [],
    loadingActivity: true,
    activityError: "",
    loadingSessions: true,
    sessionsError: "",
  };
  let active = false;
  let ready = false;
  let environmentId = "";
  let sessionsEnvironmentId = "";
  let revision = 0;
  let timer;

  function snapshot() {
    const sessions =
      sessionsEnvironmentId === getEnvironmentId() ? getSessions() : [];
    return {
      ...state,
      sessions,
      supportsSchedules: client.supportsSchedules(),
    };
  }
  const publish = () => render(snapshot());
  function hasCurrentActivityRead(readRevision, readEnvironmentId) {
    if (readRevision !== revision) return false;
    return readEnvironmentId === getEnvironmentId();
  }
  function canRefresh() {
    if (!ready) return false;
    if (!active) return false;
    return isVisible();
  }
  function scheduleRefresh() {
    clearTimer(timer);
    if (!canRefresh()) return;
    timer = setTimer(() => void refresh(), 10000);
  }
  async function refreshActivity() {
    const readEnvironmentId = getEnvironmentId();
    const readRevision = ++revision;
    const environmentChanged = environmentId !== readEnvironmentId;
    environmentId = readEnvironmentId;
    if (environmentChanged) state.runs = [];
    state.loadingActivity = state.runs.length === 0;
    state.activityError = "";
    publish();
    if (!client.supportsSchedules()) {
      state.runs = [];
      state.loadingActivity = false;
      publish();
      return;
    }
    try {
      const result = await client.listRecentScheduleRuns(readEnvironmentId, {
        limit: 8,
      });
      if (!hasCurrentActivityRead(readRevision, readEnvironmentId)) return;
      state.runs = result.runs || [];
    } catch (error) {
      if (!hasCurrentActivityRead(readRevision, readEnvironmentId)) return;
      state.activityError =
        error instanceof Error ? error.message : String(error);
    } finally {
      if (hasCurrentActivityRead(readRevision, readEnvironmentId)) {
        state.loadingActivity = false;
        publish();
      }
    }
  }
  async function refresh() {
    if (!canRefresh()) return;
    clearTimer(timer);
    await Promise.allSettled([loadSessions(), refreshActivity()]);
    scheduleRefresh();
  }
  return {
    snapshot,
    publish,
    refresh,
    setReady() {
      ready = true;
      void refresh();
    },
    setActive(value) {
      const entering = value && !active;
      active = value;
      clearTimer(timer);
      if (entering) void refresh();
    },
    sessionsChanged(status = {}) {
      if (status.environmentId && status.environmentId !== getEnvironmentId())
        return;
      if (status.status === "ready") sessionsEnvironmentId = getEnvironmentId();
      state.loadingSessions = status.status === "loading";
      state.sessionsError = status.error || "";
      publish();
    },
    environmentChanged() {
      revision += 1;
      sessionsEnvironmentId = "";
      Object.assign(state, {
        runs: [],
        activityError: "",
        sessionsError: "",
        loadingActivity: true,
        loadingSessions: true,
      });
      publish();
      void refresh();
    },
    visibilityChanged() {
      clearTimer(timer);
      if (canRefresh()) void refresh();
    },
  };
}
