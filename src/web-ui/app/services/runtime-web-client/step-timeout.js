/** Only server-recorded invocation identities are sent; timeout values stay server-owned. */
export function createStepTimeoutRequests({ requestApi, getConfig }) {
  function requireRuntimeBackend() {
    if (getConfig()?.backend !== "runtime") throw new Error("Timeout settings require the local Runtime backend.");
  }
  return {
    inspectStepTimeout(identity) {
      requireRuntimeBackend();
      return requestApi(`/runtime/config/step-timeout?${new URLSearchParams(identity)}`);
    },
    increaseStepTimeout(identity, expectedRevision) {
      requireRuntimeBackend();
      return requestApi("/runtime/config/step-timeout", {
        method: "POST", body: JSON.stringify({ ...identity, expectedRevision }),
      });
    },
  };
}
