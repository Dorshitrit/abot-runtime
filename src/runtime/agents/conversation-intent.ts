import { createHash } from "node:crypto";
import type { AgentMission, AgentState } from "./agent-records.js";
import type { AgentMessageInput } from "./application-contracts.js";
import type { AgentConversationMessage } from "./workspace-records.js";

export function recordedMessageIntent(message: AgentConversationMessage): AgentMessageInput["intent"] | null {
  if (message.inputIntent === "auto") return "auto";
  if (message.purpose === "conversation") return "message";
  if (message.purpose === "request") return "task";
  return null;
}

export function initialAgentMessage(state: AgentState, missionId: string) {
  return state.messages.find((message) => message.missionId === missionId);
}

function currentHumanWorkAttempt(state: AgentState, mission: AgentMission) {
  const origin = initialAgentMessage(state, mission.id);
  if (mission.status !== "active" || origin?.role !== "user" || origin.source || origin.purpose !== "request") return;
  const attempt = state.attempts.filter(entry => entry.missionId === mission.id).at(-1);
  const agent = state.agents.find(entry => entry.id === mission.agentId);
  if (!attempt || agent?.status !== "active" || attempt.agentId !== agent.id || attempt.agentRevision !== agent.revision ||
      attempt.missionRevision !== mission.revision || attempt.userResolved || attempt.status === "unknown") return;
  if (state.mailbox.some(entry => entry.missionId === mission.id && entry.status !== "answered")) return;
  return attempt;
}

/** Capture the only attempt the human could have been correcting when their message was admitted. */
export function activeAgentAttemptForCorrection(state: AgentState, mission: AgentMission) {
  const attempt = currentHumanWorkAttempt(state, mission);
  return attempt?.status === "settled" ? undefined : attempt;
}

export function correctableAgentAttempt(state: AgentState, mission: AgentMission, message: AgentConversationMessage) {
  if (!message.correctableAttemptId || message.agentId !== mission.agentId || message.missionId !== mission.id ||
      message.role !== "user" || message.source || message.inputIntent !== "auto" || message.purpose !== "conversation") return;
  const latest = state.messages.filter(entry => entry.missionId === mission.id && entry.role === "user").at(-1);
  if (latest?.id !== message.id) return;
  const attempt = currentHumanWorkAttempt(state, mission);
  return attempt?.id === message.correctableAttemptId ? attempt : undefined;
}

export function unansweredConversationMessages(state: AgentState, missionId: string) {
  const messages = state.messages.filter((message) => message.missionId === missionId);
  const replies = new Set(messages.filter((message) => message.role === "assistant").map((message) => message.id));
  return messages.filter((message) => message.role === "user" && message.purpose === "conversation" && !replies.has(`reply:${message.id}`));
}

/** Stable per source message and authority revision, including an explicitly authorized retry. */
export function conversationInvocationId(missionId: string, messageId: string, agentRevision: number, missionRevision: number): string {
  return "chat:" + createHash("sha256").update(JSON.stringify([missionId, messageId, agentRevision, missionRevision])).digest("hex");
}

export function pendingAutomaticQuestion(state: AgentState, missionId: string): AgentConversationMessage | undefined {
  const mission = state.missions.find((entry) => entry.id === missionId);
  if (mission?.status !== "awaiting_user_decision" || mission.waitingReason !== "Clarification requested.") return;
  if (initialAgentMessage(state, missionId)?.inputIntent !== "auto") return;
  const question = [...state.messages].reverse().find((message) => message.missionId === missionId && message.purpose === "question");
  const trace = state.responsibility.find((entry) => entry.id === question?.traceId);
  if (!question || !trace?.accepted || trace.plan.action !== "ask_user" || trace.missionRevision + 1 !== mission.revision) return;
  if (state.messages.some((message) => message.inReplyTo === question.id)) return;
  return question;
}
