const phases = {
  ready: ["Running", "success"], starting: ["Starting", "active"],
  stopping: ["Stopping", "active"], stopped: ["Stopped", "neutral"],
  idle: ["Stopped", "neutral"], installing: ["Installing", "active"],
  restoring: ["Checking", "active"], saving: ["Saving", "active"],
};

function modelSummary(server) {
  const sleeping = (server.models || []).filter(model => model.state === "sleeping").length;
  return [
    (server.settings?.models?.length || 0) + " chat models",
    sleeping ? sleeping + " sleeping" : "",
    server.settings?.embedding ? "Embeddings configured" : "",
  ].filter(Boolean).join(" · ");
}

/** Preserve lifecycle meaning instead of inferring color from description text. */
export function managedServerHomeStatus(server, unavailable = false, localOnly = false) {
  if (unavailable) return {
    status: "Status unavailable", tone: "attention", disabled: localOnly,
    detail: localOnly ? "Manage this server from the computer running ABot." : "Could not check the local server. Open to refresh its status.",
  };
  if (!server) return { status: "Checking", tone: "neutral", detail: "Checking local server…", disabled: true };
  if (server.supported === false) return {
    status: "Unavailable", tone: "neutral", disabled: true,
    detail: "Managed installation is unavailable on this computer.",
  };
  if (server.errorCode || server.phase === "error") return {
    status: "Needs attention", tone: "failed",
    detail: server.errorCode ? server.errorCode.replaceAll("_", " ") : "Open to check the local server.",
  };
  if (!server.configured && !server.busy) return {
    status: "Not set up", tone: "neutral", actionLabel: "Set up",
    detail: "Set up local models without a terminal",
  };
  const [status, tone] = phases[server.phase] || ["Status unavailable", "neutral"];
  return { status, tone, detail: modelSummary(server), actionLabel: server.configured ? "Manage" : "Set up" };
}
