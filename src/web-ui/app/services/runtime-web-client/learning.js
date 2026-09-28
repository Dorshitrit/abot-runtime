export function createPassiveLearningRequests({
  requestApi,
  getEnvironmentId,
  environmentQuery,
}) {
  const environmentPath = (suffix, environmentId) =>
    `/runtime/learning${suffix}?environment=${environmentQuery(environmentId)}`;

  return Object.freeze({
    loadPassiveLearning(environmentId = getEnvironmentId(), { signal } = {}) {
      return requestApi(
        environmentPath("", environmentId),
        signal ? { signal } : {},
      );
    },
    configurePassiveLearning(input, environmentId = getEnvironmentId()) {
      return requestApi("/runtime/learning", {
        method: "PUT",
        body: JSON.stringify({ environment: environmentId, ...input }),
      });
    },
    restartPassiveLearningCollection(environmentId = getEnvironmentId()) {
      return requestApi(environmentPath("/collection/restart", environmentId), {
        method: "POST",
        body: "{}",
      });
    },
    clearPassiveLearningPending(environmentId = getEnvironmentId()) {
      return requestApi(environmentPath("/pending", environmentId), {
        method: "DELETE",
        body: "{}",
      });
    },
    listPassiveLearningCandidates(
      environmentId = getEnvironmentId(),
      { signal } = {},
    ) {
      return requestApi(
        environmentPath("/candidates", environmentId),
        signal ? { signal } : {},
      );
    },
    dismissPassiveLearningProposal(id, environmentId = getEnvironmentId()) {
      return requestApi(
        environmentPath(`/proposals/${encodeURIComponent(id)}`, environmentId),
        {
          method: "DELETE",
          body: "{}",
        },
      );
    },
    listPassiveLearningBatches(
      environmentId = getEnvironmentId(),
      { signal } = {},
    ) {
      return requestApi(
        environmentPath("/batches", environmentId),
        signal ? { signal } : {},
      );
    },
    loadPassiveLearningBatch(
      id,
      environmentId = getEnvironmentId(),
      { signal } = {},
    ) {
      return requestApi(
        environmentPath(`/batches/${encodeURIComponent(id)}`, environmentId),
        signal ? { signal } : {},
      );
    },
  });
}
