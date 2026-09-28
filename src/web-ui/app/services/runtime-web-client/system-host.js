/** Pairing is shared by this ABot installation, independent of environments. */
export function createSystemHostRequests({ requestApi, getConfig }) {
  const supportsSystemHostConnection = () => getConfig()?.backend === "runtime";

  async function requestSystemHost(path = "", options) {
    if (!supportsSystemHostConnection()) {
      throw new Error(
        "Connected computers require the local Runtime backend. Open the Web UI served by your ABot installation.",
      );
    }
    return requestApi(`/runtime/system-host${path}`, options);
  }

  return {
    supportsSystemHostConnection,
    getSystemHostConnection: () => requestSystemHost(),
    connectLocalSystemHost: () =>
      requestSystemHost("/connect-local", { method: "POST", body: "{}" }),
    downloadSystemHostSetup: (platform, options = {}) =>
      requestSystemHost("/setup", {
        method: "POST",
        body: JSON.stringify({ platform, ...(options.purpose === "learning" ? { purpose: "learning" } : {}) }),
      }),
    createSystemHostPairing: () =>
      requestSystemHost("/pairing", { method: "POST", body: "{}" }),
    revokeSystemHostConnection: () =>
      requestSystemHost("", { method: "DELETE", body: "{}" }),
  };
}
