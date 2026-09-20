/** Configuration transport; credentials are sent once and never retained here. */
export function createConfigurationRequests({ requestApi, environmentQuery }) {
  const scoped = (path, environmentId) =>
    path + "?environment=" + environmentQuery(environmentId);
  return {
    getRuntimeSetup(environmentId) {
      return requestApi(scoped("/runtime/setup", environmentId));
    },
    saveRuntimeSetup(input, environmentId) {
      return requestApi(scoped("/runtime/setup", environmentId), {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    saveRuntimeSetupEmbedding(input, environmentId) {
      return requestApi(scoped("/runtime/setup/embedding", environmentId), {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    loadModelSetup(environmentId) {
      return requestApi(scoped("/runtime/config/models/setup", environmentId));
    },
    addRuntimeModel(input, environmentId) {
      return requestApi(scoped("/runtime/config/models", environmentId), {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    getRuntimePlugins(environmentId) {
      return requestApi(scoped("/runtime/plugins", environmentId));
    },
    setRuntimePlugin(input, environmentId) {
      return requestApi(scoped("/runtime/plugins", environmentId), {
        method: "PUT",
        body: JSON.stringify(input),
      });
    },
    applyRuntimeConfiguration(environmentId) {
      return requestApi(scoped("/runtime/config/apply", environmentId), {
        method: "POST",
        body: JSON.stringify({}),
      });
    },
  };
}
