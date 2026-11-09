/** HOME has its own request API; ordinary messages never pass through this client. */
export function createSparkHomeRequests({ requestApi, resolveApiPath, getEnvironmentId, getConfig }) {
  function path(suffix, environmentId, query = {}) {
    if (getConfig()?.backend !== "runtime") throw new Error("HOME requires a local Runtime.");
    return `/runtime/spark-home${suffix}?${new URLSearchParams({ environment: environmentId, ...query })}`;
  }
  const read = (suffix, environmentId, query) => requestApi(path(suffix, environmentId, query));
  const write = (suffix, method, input, environmentId) => requestApi(path(suffix, environmentId), {
    method, body: JSON.stringify(input),
  });
  return {
    getSparkHome: (environmentId = getEnvironmentId()) => read("", environmentId),
    getSystemMetrics: (environmentId = getEnvironmentId(), options = {}) => requestApi(path("/system-metrics", environmentId), options),
    getSparkHomeSettings: (environmentId = getEnvironmentId()) => read("/settings", environmentId),
    configureSparkHomeSettings: (input, environmentId = getEnvironmentId()) => write("/settings", "PUT", input, environmentId),
    getSparkHomePreferences: (environmentId = getEnvironmentId()) => read("/preferences", environmentId),
    configureSparkHomePreferences: (input, environmentId = getEnvironmentId()) => write("/preferences", "PUT", input, environmentId),
    getSparkHomeCalibrationOptions: (input, environmentId = getEnvironmentId()) => write("/calibration/options", "POST", input, environmentId),
    draftSparkHomeInstructions: (input, environmentId = getEnvironmentId()) => write("/calibration/draft", "POST", input, environmentId),
    startSparkHomeRun: (input, environmentId = getEnvironmentId()) => write("/runs", "POST", input, environmentId),
    getSparkHomeRun: (input = {}, environmentId = getEnvironmentId()) => read("/runs", environmentId, input.runId ? { runId: input.runId } : {}),
    cancelSparkHomeRun: (input, environmentId = getEnvironmentId()) => write("/runs/cancel", "POST", input, environmentId),
    decideSparkHomeApproval: (input, environmentId = getEnvironmentId()) => write("/runs/approval", "POST", input, environmentId),
    sparkHomeContentUrl(revision, environmentId = getEnvironmentId()) {
      if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid HOME revision.");
      return resolveApiPath(path("/content", environmentId, { revision }));
    },
  };
}
