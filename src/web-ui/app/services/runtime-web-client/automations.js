export function createAutomationRequests({ requestApi, getEnvironmentId, getConfig }) {
  const supportsAutomations = () => getConfig()?.backend === "runtime";
  const path = (suffix = "", environmentId = getEnvironmentId()) =>
    `/automations${suffix}?environment=${encodeURIComponent(environmentId)}`;
  const runPath = (runId, environmentId = getEnvironmentId()) =>
    `/automation-runs/${encodeURIComponent(runId)}?environment=${encodeURIComponent(environmentId)}`;
  const runActionPath = (runId, action, environmentId = getEnvironmentId()) =>
    `/automation-runs/${encodeURIComponent(runId)}/${action}?environment=${encodeURIComponent(environmentId)}`;
  const requestAutomation = (url, options) => {
    if (!supportsAutomations())
      throw new Error("Automations require the local Runtime backend.");
    return requestApi(url, options);
  };
  const post = (url, input) => requestAutomation(url, {
    method: "POST", body: JSON.stringify(input),
  });
  const historyPath = (automationId, environmentId, query) => {
    const params = new URLSearchParams();
    for (const key of ["limit", "cursor", "status", "from", "to"])
      if (query[key] !== undefined && query[key] !== null && query[key] !== "")
        params.set(key, String(query[key]));
    const suffix = params.size ? `&${params}` : "";
    return `${path(`/${encodeURIComponent(automationId)}/runs`, environmentId)}${suffix}`;
  };
  return {
    supportsAutomations,
    listAutomations: (environmentId) => requestAutomation(path("", environmentId)),
    createAutomation: (environmentId, templateId) => post(path("", environmentId),
      templateId ? { templateId } : {}),
    getAutomationDraft: (automationId, environmentId) =>
      requestAutomation(path(`/${encodeURIComponent(automationId)}/draft`, environmentId)),
    mutateAutomationDraft: (automationId, expectedRevision, mutation, environmentId) =>
      requestAutomation(path(`/${encodeURIComponent(automationId)}/draft`, environmentId), {
        method: "PATCH", body: JSON.stringify({ expectedRevision, mutation }),
      }),
    deleteAutomationDraft: (automationId, expectedRevision, environmentId) =>
      requestAutomation(path(`/${encodeURIComponent(automationId)}/draft`, environmentId), {
        method: "DELETE", body: JSON.stringify({ expectedRevision }),
      }),
    saveAutomationAgent: (automationId, nodeId, expectedRevision, environmentId) =>
      post(path(`/${encodeURIComponent(automationId)}/agents`, environmentId), {
        nodeId, expectedRevision,
      }),
    validateAutomation: (automationId, environmentId) =>
      post(path(`/${encodeURIComponent(automationId)}/validate`, environmentId), {}),
    publishAutomation: (automationId, expectedRevision, environmentId) =>
      post(path(`/${encodeURIComponent(automationId)}/publish`, environmentId), { expectedRevision }),
    setAutomationActive: (automationId, active, environmentId) =>
      post(path(`/${encodeURIComponent(automationId)}/${active ? "activate" : "pause"}`, environmentId), {}),
    archiveAutomation: (automationId, expectedRevision, environmentId) =>
      post(path(`/${encodeURIComponent(automationId)}/archive`, environmentId), { expectedRevision }),
    restoreAutomation: (automationId, expectedRevision, environmentId) =>
      post(path(`/${encodeURIComponent(automationId)}/restore`, environmentId), { expectedRevision }),
    setAutomationPermission: (automationId, permission, environmentId) =>
      requestAutomation(path(`/${encodeURIComponent(automationId)}/permission`, environmentId), {
        method: "PUT", body: JSON.stringify(permission),
      }),
    async getAutomationCatalog(automationId, environmentId = getEnvironmentId()) {
      const [catalog, modelCatalog] = await Promise.all([
        requestAutomation(`${path("/catalog", environmentId)}&automation=${encodeURIComponent(automationId)}`),
        requestAutomation(`/chat/models?environment=${encodeURIComponent(environmentId)}`),
      ]);
      return { ...catalog, models: (catalog.models || []).map((model) => {
        const profile = modelCatalog.profiles?.find((item) => item.id === model.id);
        const { reasoningControls: _authoringControls, ...metadata } = model;
        return { ...metadata, supportsThinking: profile?.supportsThinking === true,
          ...(profile?.reasoningControls ? { reasoningControls: profile.reasoningControls } : {}) };
      }) };
    },
    startAutomationRun: (automationId, idempotencyKey, environmentId) =>
      post(path(`/${encodeURIComponent(automationId)}/run`, environmentId), { idempotencyKey }),
    listAutomationRuns: (automationId, environmentId, query = {}) =>
      requestAutomation(historyPath(automationId, environmentId, query)),
    getAutomationRun: (runId, environmentId) => requestAutomation(runPath(runId, environmentId)),
    getAutomationStepEvidence: (runId, nodeId, environmentId, full = false) => requestAutomation(
      `/automation-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(nodeId)}?environment=${encodeURIComponent(environmentId || getEnvironmentId())}${full ? "&full=1" : ""}`),
    stopAutomationRun: (runId, environmentId) => post(runActionPath(runId, "stop", environmentId), {}),
    rerunAutomationRun: (runId, idempotencyKey, environmentId) =>
      post(runActionPath(runId, "rerun", environmentId), { idempotencyKey, confirmed: true }),
  };
}
