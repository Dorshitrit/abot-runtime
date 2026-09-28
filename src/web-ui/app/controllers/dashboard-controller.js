import { createEventRefresh } from "../lib/event-refresh.js";
import { dashboardRefreshResources } from "../lib/workspace-change.js";

export function createDashboardController({
  client,
  getEnvironmentId,
  getSessions,
  loadSessions,
  render,
  isRuntimeReady = () => true,
  isVisible = () => document.visibilityState === "visible",
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  approvalData,
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
  let runtimeReady = isRuntimeReady();
  let environmentId = "";
  let sessionsEnvironmentId = "";
  let revision = 0;
  const pendingResources = new Set();
  const eventRefresh = createEventRefresh({
    canRefresh,
    refresh: readPendingResources,
    setTimer,
    clearTimer,
  });
  let activitySettled = false;

  function snapshot() {
    const sessions =
      sessionsEnvironmentId === getEnvironmentId() ? getSessions() : [];
    return {
      ...state,
      sessions,
      supportsSchedules: client.supportsSchedules(),
      ...approvalData?.snapshot(),
    };
  }
  const publish = () => render(snapshot());
  function hasCurrentActivityRead(readRevision, readEnvironmentId) {
    if (readRevision !== revision) return false;
    return readEnvironmentId === getEnvironmentId();
  }
  function canRefresh() {
    if (!isRuntimeReady()) return false;
    if (!ready) return false;
    if (!active) return false;
    return isVisible();
  }
  function cancelRefresh() {
    eventRefresh.cancel();
    pendingResources.clear();
  }
  async function refreshActivity() {
    const readEnvironmentId = getEnvironmentId();
    const readRevision = ++revision;
    const environmentChanged = environmentId !== readEnvironmentId;
    environmentId = readEnvironmentId;
    if (environmentChanged) {
      state.runs = [];
      activitySettled = false;
      state.activityError = "";
    }
    state.loadingActivity = !activitySettled;
    publish();
    if (!client.supportsSchedules()) {
      state.runs = [];
      state.loadingActivity = false;
      activitySettled = true;
      state.activityError = "";
      publish();
      return;
    }
    try {
      const result = await client.listRecentScheduleRuns(readEnvironmentId, {
        limit: 8,
      });
      if (!hasCurrentActivityRead(readRevision, readEnvironmentId)) return;
      state.runs = result.runs || [];
      state.activityError = "";
    } catch (error) {
      if (!hasCurrentActivityRead(readRevision, readEnvironmentId)) return;
      state.activityError =
        error instanceof Error ? error.message : String(error);
    } finally {
      if (hasCurrentActivityRead(readRevision, readEnvironmentId)) {
        state.loadingActivity = false;
        activitySettled = true;
        publish();
      }
    }
  }
  async function readPendingResources() {
    const resources = [...pendingResources];
    pendingResources.clear();
    const readers = {
      sessions: loadSessions,
      activity: refreshActivity,
      approvals: () => approvalData?.refresh(),
    };
    await Promise.allSettled(resources.map((resource) => readers[resource]()));
  }
  function refresh() {
    if (!canRefresh()) return Promise.resolve();
    for (const resource of ["sessions", "activity", "approvals"])
      pendingResources.add(resource);
    return eventRefresh.run();
  }
  function handleRealtime(message) {
    if (!canRefresh()) return;
    const resources = dashboardRefreshResources(message, getEnvironmentId());
    if (!resources.length) return;
    for (const resource of resources) pendingResources.add(resource);
    eventRefresh.schedule();
  }
  return {
    snapshot,
    publish,
    refresh,
    handleRealtime,
    runtimeAvailabilityChanged() {
      const available = isRuntimeReady();
      if (runtimeReady === available) {
        publish();
        return;
      }
      runtimeReady = available;
      revision += 1;
      if (!available) approvalData?.invalidate();
      cancelRefresh();
      state.activityError = "";
      state.sessionsError = "";
      publish();
      if (available) void refresh();
    },
    setReady() {
      ready = true;
      void refresh();
    },
    setActive(value) {
      const entering = value && !active;
      active = value;
      cancelRefresh();
      if (entering) void refresh();
    },
    sessionsChanged(status = {}) {
      if (status.environmentId && status.environmentId !== getEnvironmentId())
        return;
      if (status.status === "ready") sessionsEnvironmentId = getEnvironmentId();
      state.loadingSessions =
        status.status === "loading" &&
        sessionsEnvironmentId !== getEnvironmentId();
      if (status.status !== "loading") state.sessionsError = status.error || "";
      publish();
    },
    environmentChanged() {
      cancelRefresh();
      revision += 1;
      approvalData?.invalidate();
      sessionsEnvironmentId = "";
      activitySettled = false;
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
      cancelRefresh();
      if (canRefresh()) void refresh();
    },
  };
}
