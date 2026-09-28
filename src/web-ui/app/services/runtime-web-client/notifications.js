export function createNotificationRequests({ requestApi, getConfig, getEnvironmentId }) {
  const supportsNotifications = () => getConfig()?.backend === "runtime";
  function requireNotifications() {
    if (!supportsNotifications()) throw new Error("Notifications are unavailable with this backend.");
  }
  return {
    supportsNotifications,
    listNotifications(environmentId = getEnvironmentId(), { before, limit = 50 } = {}) {
      requireNotifications();
      const query = new URLSearchParams({ environment: environmentId, limit: String(limit) });
      if (before) query.set("before", before);
      return requestApi(`/notifications?${query}`);
    },
    markNotificationsRead(input, environmentId = getEnvironmentId()) {
      requireNotifications();
      return requestApi("/notifications/read", {
        method: "POST", body: JSON.stringify({ ...input, environment: environmentId }),
      });
    },
    saveNotificationPreferences(input, environmentId = getEnvironmentId()) {
      requireNotifications();
      return requestApi("/notifications/preferences", {
        method: "PUT", body: JSON.stringify({ ...input, environment: environmentId }),
      });
    },
  };
}
