export function createModelParameterRequests({ requestApi, getConfig, getEnvironmentId }) {
  return {
    previewModelParameters(candidate, environmentId = getEnvironmentId()) {
      if (getConfig()?.backend !== "runtime") throw new Error("Model parameters require the local Runtime backend.");
      return requestApi("/runtime/config/model-parameters/preview", {
        method: "POST", body: JSON.stringify({ ...candidate, environment: environmentId }),
      });
    },
  };
}
