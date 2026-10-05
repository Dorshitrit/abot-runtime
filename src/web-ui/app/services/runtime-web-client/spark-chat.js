export function createSparkChatRequests({ requestApi, getEnvironmentId, getConfig }) {
  const supportsSparkChat = () => getConfig()?.backend === "runtime";
  function path(environmentId) {
    if (!supportsSparkChat()) throw new Error("SPARK chat is unavailable with this backend.");
    return `/runtime/spark/chat?${new URLSearchParams({ environment: environmentId })}`;
  }
  return {
    supportsSparkChat,
    loadSparkChat(environmentId = getEnvironmentId()) {
      return requestApi(path(environmentId));
    },
    configureSparkChat(input, environmentId = getEnvironmentId()) {
      return requestApi(path(environmentId), {
        method: "PUT", body: JSON.stringify(input),
      });
    },
    createSparkHandoffSession(input, environmentId = getEnvironmentId()) {
      return requestApi(path(environmentId).replace("?", "/sessions?"), {
        method: "POST", body: JSON.stringify(input),
      });
    },
    markSparkMessagesRead({ visibleMessageIds, visibleMessages, readGeneration }, environmentId = getEnvironmentId()) {
      const url = path(environmentId).replace("?", "/read?");
      return requestApi(url, {
        method: "POST", body: JSON.stringify({ visibleMessageIds, visibleMessages, readGeneration }),
      });
    },
  };
}
