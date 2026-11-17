import { normalizeRealtimeMessage } from "../lib/realtime-message.js";

function hasRequestScope(request, environmentId) {
  if ((request.environment || request.environmentId) !== environmentId) return false;
  if (typeof request.sessionId !== "string" || !request.sessionId) return false;
  return typeof request.requestId === "string" && Boolean(request.requestId);
}

function needsActivityRefresh(message) {
  if (message.type === "workspace_changed") return message.resources?.includes("sessions");
  return message.name === "session.messages.updated" || message.name === "schedule.triggered";
}

function isSupersededLifecycle(previous, lifecycle) {
  if (!previous || !lifecycle) return false;
  if (previous.generation !== lifecycle.generation) return false;
  if (previous.terminal) return true;
  return Number.isFinite(previous.lifecycleRevision) && previous.lifecycleRevision >= lifecycle.revision;
}

/** Sidebar projection only: request execution and conversation selection remain unchanged. */
export function createSessionActivityController({ client, getEnvironmentId, onChange, realtime, isConnected = () => true }) {
  let environmentId = getEnvironmentId();
  let records = new Map();
  let revision = 0;
  let readVersion = 0;
  let pending = null;
  let refreshAgain = false;

  function synchronizeEnvironment() {
    const selected = getEnvironmentId();
    if (selected === environmentId) return;
    environmentId = selected;
    records.clear();
    readVersion += 1;
    pending = null;
    refreshAgain = false;
  }

  function activeSessions() {
    return [...new Set([...records.values()].filter((record) => record.active).map((record) => record.sessionId))].sort().join("\n");
  }

  function notifyChanged(previous) {
    if (activeSessions() !== previous) onChange();
  }

  function isWorking(sessionId) {
    synchronizeEnvironment();
    return [...records.values()].some((record) => record.sessionId === sessionId && record.active);
  }

  function remember(message, active) {
    const lifecycle = message.lifecycle;
    const previous = records.get(message.requestId);
    if (isSupersededLifecycle(previous, lifecycle)) return;
    const before = activeSessions();
    records.set(message.requestId, {
      ...previous, sessionId: message.sessionId, active,
      ...(lifecycle ? { generation: lifecycle.generation, lifecycleRevision: lifecycle.revision } : {}),
      observed: ++revision,
      paused: lifecycle?.status === "awaiting_approval",
      terminal: lifecycle ? ["completed", "failed"].includes(lifecycle.status) : !active,
    });
    notifyChanged(before);
  }

  function observe(raw) {
    synchronizeEnvironment();
    const message = normalizeRealtimeMessage(raw);
    if ((message.environment || message.environmentId) !== environmentId) return;
    if (needsActivityRefresh(message)) void refresh();
    if (!hasRequestScope(message, environmentId)) return;
    if (message.name === "request.lifecycle.changed") {
      const lifecycle = message.lifecycle;
      if (lifecycle?.schemaVersion !== 1 || lifecycle.requestId !== message.requestId) return;
      if (lifecycle.sessionId !== message.sessionId) return;
      remember(message, lifecycle.status === "streaming");
      return;
    }
    if (message.type === "completed" || message.type === "failed") remember(message, false);
  }

  function applySnapshot(payload, observedAtStart) {
    if (!Array.isArray(payload.activeStreamingRequestDetails)) return;
    const before = activeSessions();
    const details = payload.activeStreamingRequestDetails.filter((request) => hasRequestScope(request, environmentId));
    const activeIds = new Set(details.map((request) => request.requestId));
    for (const [id, record] of records) {
      if (record.observed > observedAtStart || activeIds.has(id)) continue;
      records.set(id, { ...record, active: false });
    }
    for (const request of details) {
      const previous = records.get(request.requestId);
      if (previous?.observed > observedAtStart || previous?.terminal || previous?.paused) continue;
      records.set(request.requestId, { ...previous, sessionId: request.sessionId, active: true, observed: observedAtStart });
    }
    notifyChanged(before);
  }

  async function refresh() {
    synchronizeEnvironment();
    if (!client?.getSystemHealth) return;
    if (pending) { refreshAgain = true; return pending; }
    const selected = environmentId;
    const version = ++readVersion;
    const observedAtStart = revision;
    const operation = Promise.resolve().then(() => client.getSystemHealth())
      .then((payload) => {
        if (version !== readVersion || selected !== getEnvironmentId()) return;
        applySnapshot(payload, observedAtStart);
      })
      .catch(() => { /* Activity unavailable: retain received lifecycle evidence. */ })
      .finally(() => {
        if (version !== readVersion) return;
        pending = null;
        if (!refreshAgain) return;
        refreshAgain = false;
        void refresh();
      });
    pending = operation;
    return operation;
  }

  function connectionChanged() {
    if (isConnected()) return;
    const before = activeSessions();
    records.clear();
    readVersion += 1;
    pending = null;
    refreshAgain = false;
    notifyChanged(before);
  }

  realtime?.subscribeMessages(observe);
  realtime?.subscribeConnected(refresh);
  realtime?.subscribeConnectionChanged(connectionChanged);
  return { isWorking, observe, refresh };
}
