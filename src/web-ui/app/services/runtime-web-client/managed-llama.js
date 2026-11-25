/** Explicit transport only; no retained input or automatic requests. */
export function createManagedLlamaRequests({ requestApi, environmentQuery }) {
  const scoped = (path, environmentId) =>
    path + "?environment=" + environmentQuery(environmentId);
  return {
    getManagedLlamaServer(environmentId) {
      return requestApi(scoped("/runtime/managed-llama/server", environmentId));
    },
    managedLlamaServerAction(action, input = {}, environmentId) {
      if (!["inspect", "install", "configure", "start", "stop", "discover", "inspect-model"].includes(action))
        throw new Error("Unknown managed llama.cpp server action");
      return requestApi(scoped("/runtime/managed-llama/server/" + action, environmentId), {
        method: "POST", body: JSON.stringify(input),
      });
    },
    getManagedLlamaStatus(environmentId) {
      return requestApi(scoped("/runtime/managed-llama/status", environmentId));
    },
    managedLlamaAction(action, input = {}, environmentId) {
      if (!["inspect", "install", "start", "stop", "cancel"].includes(action))
        throw new Error("Unknown managed llama.cpp action");
      return requestApi(scoped("/runtime/managed-llama/" + action, environmentId), {
        method: "POST", body: JSON.stringify(input),
      });
    },
  };
}
