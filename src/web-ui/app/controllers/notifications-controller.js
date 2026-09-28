import { createEventRefresh } from "../lib/event-refresh.js";
import { normalizeRealtimeMessage } from "../lib/realtime-message.js";

export function createNotificationsController({
  client,
  getEnvironmentId,
  render,
  isVisible = () => document.visibilityState === "visible",
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const state = {
    items: [], unreadCount: 0, nextCursor: null, preferences: null,
    desktop: null, loading: false, busy: false, error: "", filter: "all",
  };
  let ready = false;
  let environmentRevision = 0;
  let readRevision = 0;
  const refreshEvents = createEventRefresh({
    canRefresh: () => ready && isVisible(),
    refresh: () => refresh(),
    setTimer, clearTimer,
  });
  const snapshot = () => ({ ...state, supported: client.supportsNotifications() });
  const publish = () => render(snapshot());
  function isCurrentEnvironment(environment, revision) {
    if (revision !== environmentRevision) return false;
    return environment === getEnvironmentId();
  }
  function isCurrentRead(environment, environmentVersion, readVersion) {
    if (!isCurrentEnvironment(environment, environmentVersion)) return false;
    return readVersion === readRevision;
  }
  function hasScopedNotifications(result, environment) {
    if (!Array.isArray(result?.items)) return false;
    return result.items.every((item) => item.environmentId === environment);
  }
  async function refresh({ append = false } = {}) {
    if (!ready) return;
    if (!client.supportsNotifications()) {
      publish();
      return;
    }
    const environment = getEnvironmentId();
    const environmentVersion = environmentRevision;
    const readVersion = ++readRevision;
    const before = append ? state.nextCursor : undefined;
    if (append && !before) return;
    state.loading = true;
    state.error = "";
    publish();
    try {
      const result = await client.listNotifications(environment, { before });
      if (!isCurrentRead(environment, environmentVersion, readVersion)) return;
      if (!hasScopedNotifications(result, environment))
        throw new Error("The notification history could not be verified. Refresh to try again.");
      const existing = append ? state.items : [];
      const seen = new Set(existing.map((item) => item.id));
      state.items = [...existing, ...result.items.filter((item) => !seen.has(item.id))];
      state.unreadCount = Math.max(0, Number(result.unreadCount) || 0);
      state.nextCursor = result.nextCursor || null;
      state.preferences = result.preferences;
      state.desktop = result.desktop;
    } catch (error) {
      if (!isCurrentRead(environment, environmentVersion, readVersion)) return;
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (isCurrentRead(environment, environmentVersion, readVersion)) {
        state.loading = false;
        publish();
      }
    }
  }
  async function mutate(operation) {
    if (state.busy) return false;
    if (!ready || !client.supportsNotifications()) return false;
    const environment = getEnvironmentId();
    const version = environmentRevision;
    readRevision += 1;
    state.busy = true;
    state.loading = false;
    state.error = "";
    publish();
    try {
      await operation(environment);
      if (!isCurrentEnvironment(environment, version)) return false;
      await refresh();
      return isCurrentEnvironment(environment, version);
    } catch (error) {
      if (!isCurrentEnvironment(environment, version)) return false;
      state.error = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (isCurrentEnvironment(environment, version)) {
        state.busy = false;
        publish();
      }
    }
  }
  async function markRead(id, read = true) {
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item) return false;
    if (item.environmentId !== getEnvironmentId()) return false;
    return mutate((environment) => client.markNotificationsRead({ ids: [id], read }, environment));
  }
  return {
    snapshot, publish, refresh, markRead,
    loadMore: () => refresh({ append: true }),
    markAllRead: () => mutate((environment) =>
      client.markNotificationsRead({ all: true, read: true }, environment)),
    savePreferences: (preferences) => mutate((environment) =>
      client.saveNotificationPreferences(preferences, environment)),
    setFilter(filter) {
      state.filter = filter === "unread" ? "unread" : "all";
      publish();
    },
    setReady() {
      ready = true;
      return refresh();
    },
    setActive(active) {
      if (active) void refresh();
    },
    environmentChanged() {
      environmentRevision += 1;
      readRevision += 1;
      refreshEvents.cancel();
      Object.assign(state, {
        items: [], unreadCount: 0, nextCursor: null, preferences: null,
        desktop: null, loading: false, busy: false, error: "",
      });
      publish();
      void refresh();
    },
    handleRealtime(rawMessage) {
      const message = normalizeRealtimeMessage(rawMessage);
      if (canRefreshNotificationEvent(message, getEnvironmentId()))
        refreshEvents.schedule();
    },
    visibilityChanged() {
      refreshEvents.cancel();
      if (isVisible()) void refresh();
    },
    dispose: refreshEvents.cancel,
  };
}

function canRefreshNotificationEvent(message, environmentId) {
  if (message.type === "system-host.changed") return true;
  if (message.type !== "workspace_changed") return false;
  if ((message.environment || message.environmentId) !== environmentId) return false;
  return message.resources?.includes("notifications") === true;
}
