const labels = {
  not_configured: "Not connected",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  paused: "Paused",
  offline: "Offline",
};

export function connectionLabel(status) {
  return labels[status?.state] || "Status unavailable";
}

export function homeDescription(status, unavailable, localOnly) {
  if (localOnly) return "Manage this connection from the Runtime computer.";
  if (unavailable) return "Connection status unavailable";
  if (!status) return "Checking connection…";
  if (status.state === "not_configured") return connectionLabel(status);
  return [connectionLabel(status), status.serverOrigin].filter(Boolean).join(" · ");
}

export function dialogIntro(step, session) {
  switch (step) {
    case "loading": return "Loading connection settings…";
    case "error": return "Connection settings are unavailable.";
    case "forget": return "Remove this connection from this computer? The Socket server keeps its own credentials.";
    case "confirm":
      if (session.preview.bindingConfirmationRequired) return "These IDs differ. Confirm that Socket should expose this local environment under the runtime ID below.";
      return "Confirm the server and runtime ID before connecting this computer.";
    case "import": return "Set up ABot Socket on your server first. Import the runtime-connection.json it creates, or enter its connection details, to connect this Runtime. Pair your phone separately with the same server.";
    default: return connectionLabel(session.status);
  }
}

export function managementNote(status) {
  switch (status.error) {
    case "socket_connection_rejected": return "The Socket server rejected these connection details. Check the runtime connection file from setup.";
    case "socket_connection_unreachable": return "The Runtime could not reach the Socket server.";
    case "socket_connection_binding_in_use": return "Another Runtime owns this Socket identity.";
    case "socket_connection_activation_failed": return "The Runtime could not start the saved connection.";
  }
  return status.state === "paused" ? "Remote access stays paused until you resume it." : "";
}

export function safeConnectionError(error) {
  const known = {
    socket_connection_binding_in_use: "This Socket runtime ID is linked to another local environment. Forget that connection there first.",
    socket_connection_bundle_invalid: "Check the Socket URL, runtime ID and token provided by ABot Socket setup.",
    socket_connection_store_unavailable: "The saved settings are unavailable. Check file access on the Runtime computer.",
    socket_connection_busy: "A Socket request is in progress. Wait for it to finish before changing this connection.",
    local_runtime_owner_busy: "The Runtime is applying settings. Reload after it finishes.",
  };
  if (Object.hasOwn(known, error?.code)) return known[error.code];
  if (error?.status === 403) return "Manage this connection from the Runtime computer.";
  if (error?.status === 409) return "The connection changed. Reload its current settings before continuing.";
  if (error?.status === 400 || error?.status === 413) return "Choose the runtime connection JSON from ABot Socket setup.";
  return "The Runtime could not confirm the connection settings. Reload to check their current state.";
}

export function readSocketBundle(raw) {
  if (typeof raw !== "string" || raw.length > 16_384) throw new Error("invalid_bundle");
  const parsed = JSON.parse(raw);
  const value = parsed?.runtimeConnection ?? parsed;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_bundle");
  const { runtimeId, agentBridgeUrl = value.endpoint, runtimeToken = value.token } = value;
  if (![runtimeId, agentBridgeUrl, runtimeToken].every(entry => typeof entry === "string" && entry.length > 0)) {
    throw new Error("invalid_bundle");
  }
  return { runtimeId, agentBridgeUrl, runtimeToken };
}
