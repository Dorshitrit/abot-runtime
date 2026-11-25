import type { AgentMission, AgentState } from "./agent-records.js";
import type { AgentConversationMessage } from "./workspace-records.js";

function limitExplanation(mission: AgentMission, code: string): string {
  switch (code) {
    case "agents_no_progress_limit_reached": {
      const count = mission.usage.consecutiveNoProgress;
      return `I stopped after ${count} consecutive work ${count === 1 ? "attempt" : "attempts"} with no new source links in the recorded results.`;
    }
    case "agents_attempt_limit_reached":
      return `I reached the task's limit of ${mission.limits.maxAttempts} work attempts.`;
    case "agents_model_call_limit_reached":
      return "I stopped because the task reached its model-call limit.";
    case "agents_token_limit_reached":
      return "The task has too few tokens left for another model call.";
    case "agents_clarification_limit_reached":
      return "I stopped because the task reached its limit on clarification rounds.";
    default:
      return "I stopped at the task's agreed limit.";
  }
}

/** Quote only settled output owned by this mission. No model call or success claim. */
export function agentExhaustionReply(state: AgentState, mission: AgentMission, code: string): string {
  const owned = (entry: { agentId: string; missionId: string }) =>
    entry.agentId === mission.agentId && entry.missionId === mission.id;
  const outputs = [
    ...state.attempts.filter(owned).flatMap((entry) => {
      const result = entry.result;
      return entry.status === "settled" && result?.status === "completed" && result.usage && result.output?.trim()
        ? [{at: entry.updatedAt, text: result.output, label: "Work session"}] : [];
    }),
    ...state.mailbox.filter(owned).flatMap((entry) =>
      entry.status === "answered" && entry.outcome && entry.usage && entry.output?.trim()
        ? [{at: entry.updatedAt, text: entry.output, label: "Agent reply"}] : []),
  ].sort((left, right) => left.at.localeCompare(right.at));
  const explanation = limitExplanation(mission, code);
  if (!outputs.length) return `${explanation} There is no recorded result to show.`;
  const previews = outputs.slice(-3).map((entry) => {
    const line = entry.text.trim().replace(/\s+/gu, " ");
    const excerpt = line.length > 600 ? line.slice(0, 599).trimEnd() + "…" : line;
    return `**${entry.label}**\n> ${excerpt}`;
  });
  return [explanation, "I saved these partial results.", ...previews].join("\n\n");
}

/** Old versions wrote this exact generated notice separately from the terminal change. */
export function projectLegacyExhaustionReply(state: AgentState, message: AgentConversationMessage): AgentConversationMessage {
  if (message.role !== "assistant" || message.source || !message.text.startsWith("The agreed allowance is exhausted (")) return message;
  const mission = state.missions.find((entry) => entry.id === message.missionId && entry.agentId === message.agentId);
  if (!mission || mission.status !== "exhausted") return message;
  const terminal = state.changes.find((entry) => entry.agentId === mission.agentId && entry.missionId === mission.id &&
    entry.kind === "agent_workspace_changed" && entry.at === mission.updatedAt && entry.reason.endsWith("_limit_reached"));
  if (!terminal || message.text !== `The agreed allowance is exhausted (${terminal.reason}). Recorded results remain available in this Agent's sessions.`) return message;
  const generated = state.changes.some((entry) => entry.agentId === mission.agentId && entry.missionId === mission.id &&
    entry.kind === "agent_workspace_changed" && entry.at === message.createdAt && entry.sequence < terminal.sequence &&
    entry.reason === "Conversation message retained in the Agent context.");
  return generated ? {...message, text: agentExhaustionReply(state, mission, terminal.reason)} : message;
}
