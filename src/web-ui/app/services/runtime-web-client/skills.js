export function createSkillRequests({ requestApi, getEnvironmentId, getConfig }) {
  const supportsSkills = () => getConfig()?.backend === "runtime";
  const path = (suffix, environmentId) =>
    `/runtime/skills${suffix}?environment=${encodeURIComponent(environmentId)}`;
  function request(suffix, environmentId, options) {
    if (!supportsSkills()) throw new Error("Skills require the local Runtime backend.");
    return requestApi(path(suffix, environmentId), options);
  }
  const identity = (id) => `/${encodeURIComponent(id)}`;
  return {
    supportsSkills,
    createPersonalSkill: ({ name, description, content }, environmentId = getEnvironmentId()) =>
      request("", environmentId, { method: "POST", body: JSON.stringify({ name, description, content }) }),
    listPersonalSkills: (environmentId = getEnvironmentId()) => request("", environmentId),
    readPersonalSkill: (id, environmentId = getEnvironmentId()) => request(identity(id), environmentId),
    updatePersonalSkill: (id, content, expectedRevision, environmentId = getEnvironmentId()) =>
      request(identity(id), environmentId, { method: "PATCH", body: JSON.stringify({ content, expectedRevision }) }),
    archivePersonalSkill: (id, expectedRevision, environmentId = getEnvironmentId()) =>
      request(`${identity(id)}/archive`, environmentId, { method: "POST", body: JSON.stringify({ expectedRevision }) }),
    restorePersonalSkill: (id, expectedRevision, environmentId = getEnvironmentId()) =>
      request(`${identity(id)}/restore`, environmentId, { method: "POST", body: JSON.stringify({ expectedRevision }) }),
  };
}
