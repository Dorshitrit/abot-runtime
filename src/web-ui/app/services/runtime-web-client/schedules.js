export function createScheduleRequests({
  requestApi,
  getEnvironmentId,
  getConfig,
}) {
  const supportsSchedules = () => getConfig()?.backend === "runtime";
  const requestSchedules = async (url, options) => {
    if (!supportsSchedules())
      throw new Error("Schedules require the local Runtime backend.");
    return requestApi(url, options);
  };
  const path = (suffix = "", environmentId = getEnvironmentId()) =>
    `/schedules${suffix}?environment=${encodeURIComponent(environmentId)}`;
  const runPagePath = (resourceSuffix, environmentId, page = {}) => {
    const query = new URLSearchParams();
    if (page.cursor !== undefined) query.set("cursor", page.cursor);
    if (page.limit !== undefined) query.set("limit", String(page.limit));
    const suffix = query.size ? `&${query}` : "";
    return path(resourceSuffix, environmentId) + suffix;
  };
  return {
    supportsSchedules,
    listSchedules: (environmentId) => requestSchedules(path("", environmentId)),
    getSchedule: (jobId, environmentId) =>
      requestSchedules(path(`/${encodeURIComponent(jobId)}`, environmentId)),
    listScheduleRuns: (jobId, environmentId, page) =>
      requestSchedules(
        runPagePath(`/${encodeURIComponent(jobId)}/runs`, environmentId, page),
      ),
    listRecentScheduleRuns: (environmentId, page) =>
      requestSchedules(runPagePath("/runs", environmentId, page)),
    createSchedule: (input, environmentId) =>
      requestSchedules(path("", environmentId), {
        method: "POST",
        body: JSON.stringify(input),
      }),
    updateSchedule: (jobId, input, environmentId) =>
      requestSchedules(path(`/${encodeURIComponent(jobId)}`, environmentId), {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    scheduleAction: (jobId, action, environmentId) =>
      requestSchedules(
        path(`/${encodeURIComponent(jobId)}/${action}`, environmentId),
        {
          method: "POST",
          body: "{}",
        },
      ),
  };
}
