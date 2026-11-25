import type { AgentMission, AgentRecord, AgentState } from "./agent-records.js";
import type { AgentConversationMessage, AgentMailboxRecord } from "./workspace-records.js";

export type BoundAgentDelegation = Readonly<{
  exchange: AgentMailboxRecord;
  message: AgentConversationMessage;
  mission: AgentMission;
  agent: AgentRecord;
}>;

/** Resolve durable delegation identity, never names, text similarity or current selection. */
export function boundAgentDelegation(state: AgentState, exchange: AgentMailboxRecord): BoundAgentDelegation | null {
  if (state.deletingAgentIds.includes(exchange.agentId) || state.deletingAgentIds.includes(exchange.recipientAgentId)) return null;
  if (!state.agents.some(agent => agent.id === exchange.agentId)) return null;
  if (!state.missions.some(mission => mission.id === exchange.missionId && mission.agentId === exchange.agentId)) return null;
  const agent = state.agents.find(entry => entry.id === exchange.recipientAgentId);
  if (!agent) return null;
  const messages = state.messages.filter(message => isDelegationReceipt(message, exchange));
  if (messages.length !== 1) return null;
  const message = messages[0]!;
  const mission = state.missions.find(entry => entry.id === message.missionId && entry.agentId === agent.id);
  if (!mission) return null;
  return { exchange, message, mission, agent };
}

function isDelegationReceipt(message: AgentConversationMessage, exchange: AgentMailboxRecord): boolean {
  if (message.role !== "abot" || message.purpose !== "request") return false;
  if (message.agentId !== exchange.recipientAgentId || !message.source) return false;
  if (message.source.agentId !== exchange.agentId || message.source.missionId !== exchange.missionId) return false;
  return message.source.correlationId === exchange.id;
}

/** A work origin is either the exact human request or an acknowledged peer assignment. */
export function boundAgentWorkOrigin(state: AgentState, agentId: string, missionId: string): AgentConversationMessage | null {
  const messages = state.messages.filter(message => message.agentId === agentId && message.missionId === missionId && message.purpose === "request");
  if (messages.length !== 1) return null;
  const message = messages[0]!;
  if (message.role === "user" && message.source === null) return message;
  if (message.role !== "abot" || !message.source) return null;
  const exchange = state.mailbox.find(entry => entry.id === message.source!.correlationId);
  if (!exchange) return null;
  const binding = boundAgentDelegation(state, exchange);
  return binding?.message.id === message.id ? message : null;
}

/** Public progress uses the original request's language without projecting private peer assignments. */
export function directAgentRequestOrigin(state: AgentState, agentId: string, missionId: string): AgentConversationMessage | null {
  const visited = new Set<string>();
  for (;;) {
    const identity = JSON.stringify([agentId, missionId]);
    if (visited.has(identity)) return null;
    visited.add(identity);
    const origin = boundAgentWorkOrigin(state, agentId, missionId);
    if (!origin) return null;
    if (!origin.source) return origin;
    agentId = origin.source.agentId;
    missionId = origin.source.missionId;
  }
}

/** A new report cannot outlive an ancestor task or spend an answered/unknown exchange allowance. */
export function hasActiveDelegatedOrigin(state: AgentState, message: AgentConversationMessage): boolean {
  const visited = new Set<string>();
  let current: AgentConversationMessage | null = message;
  while (current?.source) {
    if (visited.has(current.missionId)) return false;
    visited.add(current.missionId);
    const source = current.source;
    const exchange = state.mailbox.find(entry => entry.id === source.correlationId);
    if (!exchange || exchange.status !== "pending") return false;
    const binding = boundAgentDelegation(state, exchange);
    if (binding?.message.id !== current.id || binding.mission.status !== "active") return false;
    const parent = state.missions.find(mission => mission.id === source.missionId && mission.agentId === source.agentId);
    if (parent?.status !== "active") return false;
    if (!state.agents.some(agent => agent.id === source.agentId && agent.status === "active")) return false;
    current = boundAgentWorkOrigin(state, source.agentId, source.missionId);
    if (!current) return false;
  }
  return current?.role === "user";
}
