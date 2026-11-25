import type { AgentState } from "./agent-records.js";
import { boundAgentDelegation } from "./delegated-work-origin.js";

export type AgentApprovalTarget = Readonly<{ agentId: string; agentName: string; missionId: string }>;
export type AgentApprovalAttention = Readonly<{ targets: readonly AgentApprovalTarget[]; totalTargets: number }>;
const MAX_VISIBLE_TARGETS = 50;

/** Public navigation targets only. A parent never gains authority to approve a child's tools. */
export function projectAgentApprovalAttention(state: AgentState, agentId: string, missionId: string): AgentApprovalAttention | undefined {
  const pending = [{ agentId, missionId }];
  const visited = new Set<string>();
  const targets: AgentApprovalTarget[] = [];
  while (pending.length) {
    const owner = pending.shift()!;
    if (visited.has(owner.missionId)) continue;
    visited.add(owner.missionId);
    const agent = state.agents.find(entry => entry.id === owner.agentId);
    if (agent?.status !== "active" || state.deletingAgentIds.includes(owner.agentId)) continue;
    const mission = [...state.missions].reverse().find(entry => entry.agentId === owner.agentId);
    if (mission?.id !== owner.missionId || mission.status !== "active") continue;
    if (hasPendingOwnedApproval(state, owner.agentId, owner.missionId))
      targets.push({ agentId: owner.agentId, agentName: agent.definition.name, missionId: owner.missionId });
    for (const exchange of state.mailbox) {
      if (exchange.agentId !== owner.agentId || exchange.missionId !== owner.missionId || exchange.status !== "pending") continue;
      const child = boundAgentDelegation(state, exchange);
      if (child) pending.push({ agentId: child.mission.agentId, missionId: child.mission.id });
    }
  }
  if (!targets.length) return undefined;
  return { targets: targets.slice(0, MAX_VISIBLE_TARGETS), totalTargets: targets.length };
}

function hasPendingOwnedApproval(state: AgentState, agentId: string, missionId: string): boolean {
  return state.attempts.some(attempt => attempt.agentId === agentId && attempt.missionId === missionId &&
    attempt.status === "awaiting_approval" && !attempt.userResolved);
}
