import type { AgentApplicationDependencies, AgentWorkResult } from "./application-contracts.js";
import type { AgentState } from "./agent-records.js";
import type { AgentWorkAttempt } from "./workspace-records.js";
import { agentReturnCallEstimate } from "./work-budget-context.js";

/** Stable with agent-wrap-up:<attemptId>: changing accepted text would conflict on recovery. */
export const AGENT_WRAP_UP_GUIDANCE = "Owning Agent resource guidance: the remaining allowance is nearing its return reserve. Stop open-ended exploration and return the useful findings already established, with any unverified gaps or limitations. Organizing existing evidence does not require another search. Do not invent facts, new requirements or a user reply; return the work result to the owning Agent.";

type Usage = NonNullable<AgentWorkResult["usage"]>;
function measured(value: Usage | null): value is Usage {
  return value !== null && Number.isSafeInteger(value.modelCalls) && value.modelCalls >= 0 &&
    Number.isSafeInteger(value.totalTokens) && value.totalTokens >= 0;
}
function activeWork(state: AgentState, agentId: string) {
  const agent = state.agents.find(entry => entry.id === agentId);
  const mission = [...state.missions].reverse().find(entry => entry.agentId === agentId);
  if (!agent || agent.status !== "active" || state.deletingAgentIds.includes(agentId) || mission?.status !== "active") return null;
  const attempts = state.attempts.filter(attempt => attempt.agentId === agentId && attempt.missionId === mission.id &&
    attempt.claimId && !attempt.userResolved && ["claimed", "running", "awaiting_approval"].includes(attempt.status));
  if (attempts.length !== 1) return null;
  const attempt = attempts[0]!;
  if (attempt.request.agentId !== agentId || attempt.request.missionId !== mission.id || attempt.request.attemptId !== attempt.id) return null;
  if (!state.sessions.some(session => session.agentId === agentId && session.sessionId === attempt.request.sessionId)) return null;
  return { agent, mission, attempt };
}
function sameAttempt(left: AgentWorkAttempt, right: AgentWorkAttempt): boolean {
  return left.id === right.id && left.claimId === right.claimId && left.fingerprint === right.fingerprint &&
    left.status === right.status && left.request.requestId === right.request.requestId && left.request.sessionId === right.request.sessionId;
}

/** A soft planning signal, never a new model call, final receipt, permission or user message. */
export function createAgentWorkGuidance(deps: AgentApplicationDependencies) {
  const attempted = new Set<string>();
  const inflight = new Map<string, Promise<void>>();
  async function inspectCurrent(agentId: string): Promise<void> {
    if (!deps.work.adviseWrapUp || !deps.work.inspectUsage) return;
    const state = await deps.store.read();
    const work = activeWork(state, agentId);
    if (!work || attempted.has(work.attempt.id)) return;
    const observed = await deps.work.inspect(work.attempt.request).catch(() => null);
    if (observed?.status !== "running") return; // Saved ASK waits retain their existing approval flow.
    const usage = await deps.work.inspectUsage(work.attempt.request).catch(() => null);
    if (!measured(usage)) return;
    const fresh = activeWork(await deps.store.read(), agentId);
    if (!fresh || fresh.agent.revision !== work.agent.revision || fresh.mission.id !== work.mission.id ||
      fresh.mission.revision !== work.mission.revision || !sameAttempt(fresh.attempt, work.attempt)) return;
    const remainingCalls = fresh.mission.limits.maxModelCalls - fresh.mission.usage.modelCalls - usage.modelCalls;
    const remainingTokens = fresh.mission.limits.maxTotalTokens - fresh.mission.usage.totalTokens - usage.totalTokens;
    if (remainingCalls <= 0 || remainingTokens <= 0) return; // The hard observer owns exhaustion.
    const returnCalls = agentReturnCallEstimate(fresh.agent);
    // This is an observed mean, not a predicted provider cap. Unmeasured calls never become token charges.
    const workMean = usage.modelCalls > 0 ? usage.totalTokens / usage.modelCalls : 0;
    const managementMean = fresh.mission.usage.modelCalls > 0 ? fresh.mission.usage.totalTokens / fresh.mission.usage.modelCalls : 0;
    const estimatedCallTokens = workMean > 0 ? workMean : managementMean > 0 ? managementMean : deps.managementTokenReservation ?? 0;
    if (remainingCalls > returnCalls && remainingTokens > estimatedCallTokens * returnCalls) return;
    attempted.add(work.attempt.id); // Unknown delivery is not automatically retried by this owner.
    const result = await deps.work.adviseWrapUp(work.attempt.request).catch(() => "unavailable" as const);
    if (result === "deferred") attempted.delete(work.attempt.id);
  }
  function inspect(agentId: string): Promise<void> {
    const pending = inflight.get(agentId);
    if (pending) return pending;
    const operation = inspectCurrent(agentId).finally(() => inflight.delete(agentId));
    inflight.set(agentId, operation);
    return operation;
  }
  return { inspect };
}
