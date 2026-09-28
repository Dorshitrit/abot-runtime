import { normalizeRealtimeMessage } from "./realtime-message.js";

export function isWorkspaceChange(message) {
  if (message.type === "workspace_changed") return true;
  if (message.type === "learning.changed") return true;
  return (
    message.type === "event" &&
    ["scheduler.changed", "session.messages.updated"].includes(message.name)
  );
}

export function dashboardRefreshResources(rawMessage, environmentId) {
  const message = normalizeRealtimeMessage(rawMessage);
  if ((message.environment || message.environmentId) !== environmentId)
    return [];
  if (message.type === "workspace_changed") {
    const resources = Array.isArray(message.resources) ? message.resources : [];
    return resources.filter(
      (resource) => resource === "sessions" || resource === "approvals",
    );
  }
  if (message.type === "event" && message.name === "scheduler.changed")
    return ["activity", "sessions"];
  if (message.type === "completed" || message.type === "failed")
    return ["sessions", "approvals"];
  if (message.type === "chat_message" || message.type === "chat_read_state")
    return ["sessions"];
  if (
    message.type === "event" &&
    ["session.title.updated", "session.messages.updated"].includes(message.name)
  )
    return ["sessions"];
  return [];
}
