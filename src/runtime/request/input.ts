import {
  resolveToolPermissionMode,
  type ToolPermissionMode,
} from "../../capabilities/tool-permission-mode.js";
import type { RunRequestMessage } from "./contracts.js";

export function parseRequestInput(msg: RunRequestMessage): {
  requestId: string;
  sessionId: string;
  prompt: string;
  rawAttachments: unknown;
  rawAgentMode: unknown;
  rawModelPreference: unknown;
  toolPermissionMode: ToolPermissionMode;
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
