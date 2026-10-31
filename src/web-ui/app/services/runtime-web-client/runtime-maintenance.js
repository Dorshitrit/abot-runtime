export function createRuntimeMaintenanceRequests({ requestApi, environmentQuery, getConfig }) {
  const supportsRuntimeMaintenance = () => getConfig()?.backend === "runtime";
  function reset(action, environmentId) {
    if (!supportsRuntimeMaintenance()) throw new Error("Runtime maintenance is unavailable.");
    return requestApi(`/runtime/maintenance/${action}?environment=${environmentQuery(environmentId)}`, {
      method: "POST", body: JSON.stringify({ confirmed: true }),
    });
  }
  return {
    supportsRuntimeMaintenance,
    resetRuntimeSessions: (environmentId) => reset("sessions", environmentId),
    clearRuntimeLogs: (environmentId) => reset("logs", environmentId),
  };
}
