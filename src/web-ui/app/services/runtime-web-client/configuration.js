import { createPluginConfigurationRequests } from "./plugin-configuration.js";
/** Configuration transport; credentials are sent once and never retained here. */
export function createConfigurationRequests({ requestApi, environmentQuery }) {
  const scoped = (path, environmentId) =>
    path + "?environment=" + environmentQuery(environmentId);
  return {
    ...createPluginConfigurationRequests({ requestApi, environmentQuery }),
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
    removeRuntimeModel(input, environmentId) {
      return requestApi(scoped("/runtime/config/models", environmentId), {
        method: "DELETE",
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
    inspectRuntimePlugin(input, environmentId) {
      return requestApi(scoped("/runtime/plugins/inspect", environmentId), {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    installRuntimePlugin(input, environmentId) {
      return requestApi(scoped("/runtime/plugins/install", environmentId), {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    removeRuntimePlugin(input, environmentId) {
      return requestApi(scoped("/runtime/plugins/remove", environmentId), {
        method: "POST",
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
