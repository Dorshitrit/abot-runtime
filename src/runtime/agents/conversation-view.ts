import type { AgentConversationMessage } from "./workspace-records.js";

export function visibleAgentReplies(messages: readonly AgentConversationMessage[], agentId: string) {
  const delegated = new Set<string>(), directReplies = new Map<string, string>();
  return messages.filter((message) => {
    if (message.agentId !== agentId) return false;
    if (message.role === "abot" && message.source && message.purpose !== "clarification") delegated.add(message.missionId);
    if (delegated.has(message.missionId)) {
      if (message.role === "user" && message.purpose === "conversation") directReplies.set(`reply:${message.id}`, message.missionId);
      if (directReplies.get(message.id) !== message.missionId) return false;
    }
    return message.role === "assistant" && Boolean(message.text.trim());
  });
}
