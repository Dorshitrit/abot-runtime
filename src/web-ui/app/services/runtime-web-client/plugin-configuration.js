/** Plugin configuration transport never retains entered credentials. */
export function createPluginConfigurationRequests({
  requestApi,
  environmentQuery,
}) {
  const path = (pluginId, environmentId) =>
    `/runtime/plugins/configuration/${encodeURIComponent(pluginId)}?environment=${environmentQuery(environmentId)}`;
  return {
    getPluginConfiguration(pluginId, environmentId) {
      return requestApi(path(pluginId, environmentId));
    },
    savePluginConfiguration(pluginId, input, environmentId) {
      return requestApi(path(pluginId, environmentId), {
        method: "PUT",
        body: JSON.stringify(input),
      });
    },
  };
}
