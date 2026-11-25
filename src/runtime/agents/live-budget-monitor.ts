import type { AgentApplicationDependencies, AgentWorkResult } from "./application-contracts.js";
import type { AgentMission, AgentState } from "./agent-records.js";
import { UNKNOWN_AGENT_WORK } from "./application-dispatch.js";

type Usage = NonNullable<AgentWorkResult["usage"]>;
export type AgentBudgetStopReason = "agents_token_limit_reached" | "agents_model_call_limit_reached";

export function agentBudgetStopReason(mission: AgentMission): AgentBudgetStopReason | null {
  if (mission.waitingReason === "agents_token_limit_reached") return mission.waitingReason;
  if (mission.waitingReason === "agents_model_call_limit_reached") return mission.waitingReason;
  return null;
}
function isMeasuredLowerBound(value: Usage | null): value is Usage {
  if (!value) return false;
  if (!Number.isSafeInteger(value.modelCalls) || value.modelCalls < 0) return false;
  return Number.isSafeInteger(value.totalTokens) && value.totalTokens >= 0;
}
function reachedBudget(state: AgentState, mission: AgentMission, observed: ReadonlyMap<string, Usage>): AgentBudgetStopReason | null {
  let calls = mission.usage.modelCalls, tokens = mission.usage.totalTokens;
  for (const attempt of state.attempts) {
    if (attempt.agentId !== mission.agentId || attempt.missionId !== mission.id || attempt.status === "settled" || attempt.userResolved) continue;
    const usage = observed.get(attempt.id);
    if (!usage) continue; // No receipt is invented: the known ledger remains a lower bound.
    calls += usage.modelCalls; tokens += usage.totalTokens;
  }
  if (tokens >= mission.limits.maxTotalTokens) return "agents_token_limit_reached";
  if (calls >= mission.limits.maxModelCalls) return "agents_model_call_limit_reached";
  return null;
}

/** Agent-owned supervision through ordinary observation/cancellation. An in-flight call may overshoot. */
export function createAgentLiveBudgetMonitor(deps: AgentApplicationDependencies, interrupt: (agentId: string, missionId: string) => void) {
  const requested = new Set<string>();
  async function stop(agentId: string, missionId: string, reason: AgentBudgetStopReason): Promise<void> {
    const retained = await deps.store.commitApplication({kind:"mark_agent_waiting",agentId,missionId,reason});
    const mission = retained.missions.find(entry => entry.id === missionId && entry.agentId === agentId);
    if (mission?.status !== "awaiting_user_decision" || agentBudgetStopReason(mission) !== reason) return;
    interrupt(agentId, missionId);
    for (const attempt of retained.attempts) {
      if (attempt.agentId !== agentId || attempt.missionId !== missionId || attempt.status === "settled" || attempt.userResolved || requested.has(attempt.id)) continue;
      const current = await deps.store.read();
      const retainedMission = current.missions.find(entry => entry.id === missionId && entry.agentId === agentId);
      const retainedAttempt = current.attempts.find(entry => entry.id === attempt.id);
      if (retainedMission?.status !== "awaiting_user_decision" || agentBudgetStopReason(retainedMission) !== reason) return;
      if (!retainedAttempt || retainedAttempt.status === "settled" || retainedAttempt.userResolved) continue;
      requested.add(attempt.id);
      const result = await deps.work.cancel?.(attempt.request).catch(() => UNKNOWN_AGENT_WORK) ?? UNKNOWN_AGENT_WORK;
      await deps.store.commitApplication({kind:"observe_agent_work",agentId,attemptId:attempt.id,result});
    }
    const state = await deps.store.read();
    const current = state.missions.find(entry => entry.id === missionId && entry.agentId === agentId);
    if (current?.status !== "awaiting_user_decision" || agentBudgetStopReason(current) !== reason) return;
    if (state.attempts.some(attempt => attempt.agentId === agentId && attempt.missionId === missionId && attempt.status !== "settled" && !attempt.userResolved)) return;
    // This is a system outcome, not invented model speech. Existing UI projects the recorded reason.
    await deps.store.commitApplication({kind:"finish_agent_turn",agentId,missionId,status:"exhausted",reason:`agents_budget_stop:${reason}`});
  }
  async function inspect(agentId: string): Promise<boolean> {
    const state = await deps.store.read();
    const mission = [...state.missions].reverse().find(entry => entry.agentId === agentId);
    if (!mission) return false;
    const stopped = agentBudgetStopReason(mission);
    if (stopped && mission.status === "awaiting_user_decision") {
      await stop(agentId, mission.id, stopped); return true;
    }
    if (mission.status !== "active") return false;
    const work = state.attempts.filter(attempt => attempt.agentId === agentId && attempt.missionId === mission.id && attempt.claimId &&
      attempt.status !== "settled" && attempt.status !== "prepared" && !attempt.userResolved);
    if (!work.length) return false;
    const observed = new Map<string, Usage>();
    for (const attempt of work) {
      const usage = deps.work.inspectUsage ? await deps.work.inspectUsage(attempt.request).catch(() => null) : attempt.result?.usage ?? null;
      if (isMeasuredLowerBound(usage)) observed.set(attempt.id, usage);
    }
    const latest = await deps.store.read();
    const current = latest.missions.find(entry => entry.id === mission.id && entry.agentId === agentId);
    if (current?.status !== "active" || current.revision !== mission.revision) return false;
    const reason = reachedBudget(latest, current, observed);
    if (!reason) return false;
    await stop(agentId, mission.id, reason);
    return true;
  }
  return { inspect };
}
