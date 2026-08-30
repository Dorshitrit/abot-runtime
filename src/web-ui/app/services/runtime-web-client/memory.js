export function createLongTermMemoryRequests({
  requestApi,
  getEnvironmentId,
  environmentQuery,
}) {
  return Object.freeze({
    loadLongTermMemoryStatus(environmentId = getEnvironmentId()) {
      return requestApi(
        `/runtime/memory?environment=${environmentQuery(environmentId)}`,
      );
    },

    discoverLongTermMemoryModels({
      environmentId = getEnvironmentId(),
      providerId,
    }) {
      return requestApi(
        `/runtime/memory/models?environment=${environmentQuery(
          environmentId,
        )}&provider=${encodeURIComponent(providerId)}`,
      );
    },

    enableLongTermMemory({
      environmentId = getEnvironmentId(),
      providerId,
      model,
      profileId,
      emitClientEvents,
    }) {
      return requestApi("/runtime/memory/enable", {
        method: "POST",
        body: JSON.stringify({
          environment: environmentId,
          providerId,
          model,
          profileId,
          emitClientEvents,
        }),
      });
    },

    disableLongTermMemory(environmentId = getEnvironmentId()) {
      return requestApi("/runtime/memory/disable", {
        method: "POST",
        body: JSON.stringify({ environment: environmentId }),
      });
    },

    listLongTermMemories({
      environmentId = getEnvironmentId(),
      limit = 20,
      offset = 0,
      signal,
    } = {}) {
      return requestApi(
        memoryRecordsPath({ environmentId, limit, offset }),
        signal ? { signal } : {},
      );
    },

    searchLongTermMemories({
      environmentId = getEnvironmentId(),
      query,
      limit = 20,
      offset = 0,
      signal,
    }) {
      return requestApi(
        memoryRecordsPath({ environmentId, limit, offset, query }),
        signal ? { signal } : {},
      );
    },

    createLongTermMemory({
      environmentId = getEnvironmentId(),
      content,
      tags,
    }) {
      return requestApi("/runtime/memory/records", {
        method: "POST",
        body: JSON.stringify({ environment: environmentId, content, tags }),
      });
    },

    updateLongTermMemory({
      environmentId = getEnvironmentId(),
      id,
      content,
      tags,
      expectedUpdatedAt,
    }) {
      return requestApi(`/runtime/memory/records/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          environment: environmentId,
          content,
          tags,
          expectedUpdatedAt,
        }),
      });
    },

    deleteLongTermMemory({ environmentId = getEnvironmentId(), id }) {
      return requestApi(
        `/runtime/memory/records/${encodeURIComponent(
          id,
        )}?environment=${environmentQuery(environmentId)}`,
        { method: "DELETE" },
      );
    },
  });
}

function memoryRecordsPath({ environmentId, limit, offset, query }) {
  const params = new URLSearchParams({
    environment: environmentId,
    limit: String(limit),
    offset: String(offset),
  });
  if (query !== undefined) params.set("q", query);
  const route =
    query === undefined
      ? "/runtime/memory/records"
      : "/runtime/memory/records/search";
  return `${route}?${params}`;
}
