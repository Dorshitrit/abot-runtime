import { connectionLabel, homeDescription } from "./presentation.js";

const tones = {
  connected: "success", connecting: "active", reconnecting: "active",
  offline: "failed", paused: "neutral", not_configured: "neutral",
};

/** Home status describes the connection, independently of management actions. */
export function socketHomeStatus(connection, unavailable = false, localOnly = false) {
  if (localOnly) return {
    status: "Unavailable", tone: "neutral", disabled: true,
    detail: homeDescription(connection, unavailable, localOnly),
  };
  if (unavailable) return {
    status: "Status unavailable", tone: "attention",
    detail: homeDescription(connection, true, false),
  };
  if (!connection) return { status: "Checking", tone: "neutral", detail: "Checking connection…", disabled: true };
  return {
    status: connectionLabel(connection), tone: tones[connection.state] || "neutral",
    detail: connection.serverOrigin || homeDescription(connection, false, false),
    actionLabel: connection.state === "not_configured" ? "Connect" : "Manage",
  };
}
