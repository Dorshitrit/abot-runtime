export function createProjectRequests({
  requestApi,
  getEnvironmentId,
  getConfig,
}) {
  const supportsProjects = () => getConfig()?.supportsProjects === true;
  const path = (suffix = "", environmentId = getEnvironmentId()) =>
    `/projects${suffix}?environment=${encodeURIComponent(environmentId)}`;
  async function requestProjects(url, options) {
    if (!supportsProjects())
      throw new Error("Projects are unavailable on this server.");
    return requestApi(url, options);
  }
  return {
    supportsProjects,
    listProjects: (environmentId) => requestProjects(path("", environmentId)),
    browseProjectFolders(directory = "", cursor = "", environmentId) {
      const query = new URLSearchParams();
      if (directory) query.set("path", directory);
      if (cursor) query.set("cursor", cursor);
      return requestProjects(`${path("/folders", environmentId)}&${query}`);
    },
    createProject: (input, environmentId) =>
      requestProjects(path("", environmentId), {
        method: "POST",
        body: JSON.stringify(input),
      }),
    createProjectSession: (projectId, environmentId) =>
      requestProjects(
        path(`/${encodeURIComponent(projectId)}/sessions`, environmentId),
        { method: "POST", body: "{}" },
      ),
  };
}
