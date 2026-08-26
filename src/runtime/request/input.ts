import type { RunRequestMessage } from "./contracts.js";

export function parseRequestInput(msg: RunRequestMessage): {
  requestId: string;
  sessionId: string;
  prompt: string;
  rawAttachments: unknown;
  rawAgentMode: unknown;
  rawModelPreference: unknown;
  toolPermissionMode: "full_access" | "ask";
} {
  return {
    requestId: msg.requestId,
    sessionId: typeof msg.sessionId === "string" ? msg.sessionId.trim() : "",
    prompt:
      typeof msg.input === "string"
        ? msg.input
        : typeof msg.text === "string"
          ? msg.text
          : "",
    rawAttachments: msg.attachments,
    rawAgentMode: msg.agentMode,
    rawModelPreference: msg.modelPreference,
    toolPermissionMode: resolveToolPermissionMode(msg.toolPermissionMode),
  };
}

function resolveToolPermissionMode(value: unknown): "full_access" | "ask" {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "full_access" || normalized === "full"
    ? "full_access"
    : "ask";
}
