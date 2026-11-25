export function createAgentRequests({ requestApi, getEnvironmentId, getConfig }) {
  const supportsAgents = () => getConfig()?.backend === "runtime";
  const path = (id = "", suffix = "", environmentId = getEnvironmentId()) => `/agents${id ? `/${encodeURIComponent(id)}` : ""}${suffix}?environment=${encodeURIComponent(environmentId)}`;
  const request = (url, options) => {
    if (!supportsAgents()) throw new Error("Agents require the local Runtime backend.");
    return requestApi(url, options);
  };
  const post = (url, input) => request(url, { method: "POST", body: JSON.stringify(input) });
  return {
    supportsAgents,
    previewAgentAuthoring: (input, environmentId) => post(path("authoring", "/preview", environmentId), input),
    listAgents: (environmentId) => request(path("", "", environmentId)),
    getAgent: (id, environmentId) => request(path(id, "", environmentId)),
    readAgentReplies: (id, through, environmentId) => post(path(id, "/read", environmentId), { through }),
    getAgentSession: (id, sessionId, environmentId) => request(path(id, `/sessions/${encodeURIComponent(sessionId)}`, environmentId)),
    listAgentSchedules: (id, environmentId) => request(path(id, "/schedules", environmentId)),
    createAgentSchedule: (id, input, environmentId) => post(path(id, "/schedules", environmentId), input),
    updateAgentSchedule: (id, scheduleId, input, environmentId) => request(path(id, `/schedules/${encodeURIComponent(scheduleId)}`, environmentId), { method: "PATCH", body: JSON.stringify(input) }),
    cancelAgentSchedule: (id, scheduleId, input, environmentId) => post(path(id, `/schedules/${encodeURIComponent(scheduleId)}/cancel`, environmentId), input),
    createAgent: (input, environmentId) => post(path("", "", environmentId), input),
    updateAgent: (id, input, environmentId) => request(path(id, "", environmentId), { method: "PATCH", body: JSON.stringify(input) }),
    deleteAgent: (id, input, environmentId) => request(path(id, "", environmentId), { method: "DELETE", body: JSON.stringify(input) }),
    sendAgentMessage: (id, input, environmentId) => post(path(id, "/messages", environmentId), input),
    actOnAgent: (id, input, environmentId) => post(path(id, "/actions", environmentId), input),
    decideAgentApproval: (id, input, environmentId) => post(path(id, "/approval", environmentId), input),
  };
}
