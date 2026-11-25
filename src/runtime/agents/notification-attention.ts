import { projectAgentBudgetStop } from "./budget-stop-view.js";
import type { SessionRequestLifecycleSnapshot } from "../../sessions/request-lifecycle/contracts.js";
import { createHash } from "node:crypto";
import type { AgentMission, AgentState } from "./agent-records.js";
import { projectAgentAttention, type AgentAttentionCursor } from "./attention.js";
import { initialAgentMessage } from "./conversation-intent.js";

export const AGENT_NOTIFICATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export type AgentNotificationReason = "reply" | "question" | "completed" | "result" | "exhausted" | "plan" | "attention";
export type AgentNotificationCursor = Readonly<{
  attention: readonly AgentAttentionCursor[];
  waits: readonly { missionId: string; revision: number }[];
  approvals?: readonly string[];
  delivered?: readonly string[];
}>;
export type AgentNotificationEntry = Readonly<{
  eventId: string; targetAgentId: string; missionId: string; messageId?: string;
  agentName?: string; attentionKind?: "approval" | "decision" | "budget";
  reason: AgentNotificationReason; createdAt: number; expiresAt: number; output: string;
}>;
export type AgentNotificationPage = Readonly<{ cursor: AgentNotificationCursor; entries: readonly AgentNotificationEntry[] }>;
export type AgentNotificationSource = Readonly<{
  read(cursor: AgentNotificationCursor, since: number): Promise<AgentNotificationPage>;
}>;
export const emptyAgentNotificationCursor = (): AgentNotificationCursor => ({ attention: [], waits: [] });

function identity(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
function isPublicMission(state: AgentState, mission: AgentMission): boolean {
  const origin = initialAgentMessage(state, mission.id);
  return origin?.role === "user" && !origin.source;
}
function isUnreportedWait(state: AgentState, mission: AgentMission): boolean {
  if (mission.status !== "awaiting_user_decision") return false;
  // This is the canonical pause marker written by application.pause, not model prose.
  if (mission.waitingReason === "Paused by the user.") return false;
  if (!isPublicMission(state, mission)) return false;
  if (state.deletingAgentIds.includes(mission.agentId)) return false;
  if (!state.agents.some(agent => agent.id === mission.agentId && agent.status === "active")) return false;
  const traces = state.responsibility.filter(trace => trace.agentId === mission.agentId && trace.missionId === mission.id);
  if (traces.some(trace => trace.missionRevision + 1 === mission.revision && trace.code === "malformed_proposal")) return false;
  const currentQuestions = new Set(traces.filter(trace => trace.accepted && trace.plan.action === "ask_user" &&
    trace.missionRevision + 1 === mission.revision).map(trace => trace.id));
  return !state.messages.some(message => message.missionId === mission.id && message.purpose === "question" &&
    message.traceId && currentQuestions.has(message.traceId));
}

/** Public delivery projection only. It never changes mission state or invents model text. */
export function projectAgentNotifications(state: AgentState, cursor: AgentNotificationCursor, since: number, approvalWaits: readonly SessionRequestLifecycleSnapshot[] = []): AgentNotificationPage {
  const attention = projectAgentAttention(state, cursor.attention, since);
  const entries: AgentNotificationEntry[] = attention.entries.map(entry => ({
    eventId: identity([entry.agentId, entry.missionId, entry.messageId]),
    targetAgentId: entry.agentId, agentName: entry.agentName, missionId: entry.missionId, messageId: entry.messageId,
    reason: entry.kind, createdAt: entry.createdAt, expiresAt: entry.createdAt + AGENT_NOTIFICATION_RETENTION_MS,
    output: entry.text.slice(0, 600),
  }));
  const prior = new Map(cursor.waits.map(wait => [wait.missionId, wait.revision]));
  const waits: { missionId: string; revision: number }[] = [];
  for (const mission of state.missions) {
    const terminalBudget = mission.status === "exhausted" && !state.deletingAgentIds.includes(mission.agentId) &&
      state.agents.some(agent => agent.id === mission.agentId && agent.status === "active") &&
      !state.messages.some(message => message.agentId === mission.agentId && message.missionId === mission.id &&
        message.role === "assistant" && message.createdAt === mission.updatedAt) && projectAgentBudgetStop(state, mission).budgetStopReason;
    if (!terminalBudget && !isUnreportedWait(state, mission)) continue;
    const createdAt = Date.parse(mission.updatedAt);
    if (terminalBudget && createdAt <= since) continue;
    waits.push({ missionId: mission.id, revision: mission.revision });
    if (prior.get(mission.id) === mission.revision) continue;
    if (createdAt <= since) continue;
    entries.push({ eventId: terminalBudget ? identity([mission.agentId, mission.id, "budget", terminalBudget]) : identity([mission.agentId, mission.id, "attention", mission.revision, mission.waitingReason]),
      targetAgentId: mission.agentId, agentName: state.agents.find(agent => agent.id === mission.agentId)?.definition.name,
      attentionKind: terminalBudget ? "budget" : "decision", missionId: mission.id, reason: "attention", createdAt,
      expiresAt: createdAt + AGENT_NOTIFICATION_RETENTION_MS, output: "" });
  }
  const approvals: string[] = [];
  for (const snapshot of approvalWaits) {
    if (snapshot.status !== "awaiting_approval" || !snapshot.wait) continue;
    const attempt = state.attempts.find(item => item.status === "awaiting_approval" && !item.userResolved &&
      item.request.sessionId === snapshot.sessionId && item.request.requestId === snapshot.requestId);
    if (!attempt || state.deletingAgentIds.includes(attempt.agentId)) continue;
    if (!state.agents.some(agent => agent.id === attempt.agentId && agent.status === "active")) continue;
    if (!state.missions.some(mission => mission.id === attempt.missionId && mission.agentId === attempt.agentId && mission.status === "active")) continue;
    const eventId = identity([attempt.agentId, attempt.missionId, "approval", snapshot.requestId, snapshot.generation, snapshot.wait.waitId]);
    approvals.push(eventId);
    const createdAt = Date.parse(snapshot.wait.createdAt);
    if (cursor.approvals?.includes(eventId) || createdAt <= since) continue;
    entries.push({ eventId, targetAgentId: attempt.agentId, agentName: state.agents.find(agent => agent.id === attempt.agentId)?.definition.name,
      attentionKind: "approval", missionId: attempt.missionId, reason: "attention", createdAt,
      expiresAt: createdAt + AGENT_NOTIFICATION_RETENTION_MS, output: "" });
  }
  const acknowledged = new Set(cursor.delivered ?? []);
  const fresh = entries.filter(entry => !acknowledged.has(entry.eventId));
  fresh.sort((left, right) => left.createdAt - right.createdAt || left.eventId.localeCompare(right.eventId));
  const page = fresh.slice(0, 50);
  if (fresh.length > page.length) return {
    cursor: { ...cursor, delivered: [...acknowledged, ...page.map(entry => entry.eventId)] }, entries: page,
  };
  return { cursor: { attention: attention.cursors, waits, approvals }, entries: page };
}
