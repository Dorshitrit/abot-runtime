export function createInformationBasketRequests({ requestApi, getEnvironmentId, getConfig }) {
  const supportsInformationBasket = () => getConfig()?.backend === "runtime";
  function request(suffix, environmentId, options, query = {}) {
    if (!supportsInformationBasket()) throw new Error("Resources require the local Runtime backend.");
    const parameters = new URLSearchParams({ environment: environmentId, ...query });
    return requestApi(`/runtime/information-basket${suffix}?${parameters}`, options);
  }
  const mutation = (method, body) => ({ method, body: JSON.stringify(body) });
  const identity = (id) => `/${encodeURIComponent(id)}`;
  return {
    supportsInformationBasket,
    listInformationBasket: (environmentId = getEnvironmentId()) => request("", environmentId),
    registerInformationBasketSources: (paths, environmentId = getEnvironmentId()) =>
      request("", environmentId, mutation("POST", { paths })),
    saveInformationBasketSettings: (settings, environmentId = getEnvironmentId()) =>
      request("/settings", environmentId, mutation("POST", settings)),
    browseInformationBasket: (path = "", environmentId = getEnvironmentId(), cursor = "") =>
      request("/browse", environmentId, undefined, { ...(path ? { path } : {}), ...(cursor ? { cursor } : {}) }),
    reindexInformationBasketSource: (id, expectedRevision, environmentId = getEnvironmentId()) =>
      request(`${identity(id)}/reindex`, environmentId, mutation("POST", { expectedRevision })),
    relinkInformationBasketSource: (id, expectedRevision, path, environmentId = getEnvironmentId()) =>
      request(`${identity(id)}/relink`, environmentId, mutation("POST", { expectedRevision, path })),
    removeInformationBasketSource: (id, expectedRevision, environmentId = getEnvironmentId()) =>
      request(identity(id), environmentId, mutation("DELETE", { expectedRevision })),
  };
}
