import type { AgentMission, AgentRecord, AgentState } from "./agent-records.js";
import type { AgentInvocationStage } from "./invocation-records.js";
import type { AgentActionPlan } from "./workspace-records.js";
import { AGENT_WORKSPACE_TEXT_LIMIT } from "./workspace-validation.js";
import { AgentStateError } from "./state-error.js";

export const AGENT_BOUNDED_WORK_INSTRUCTIONS = "Use the remaining work rounds and allowance to choose the smallest useful next step. Prefer a useful partial answer over repeated work that does not close a specific gap. Do not add requirements the user did not ask for.";

/** A planning estimate for returning through the executor and Agent, never a provider cap. */
export function agentReturnCallEstimate(agent: AgentRecord): number {
  return agent.definition.executionPolicy === "supervisor-worker-v1" ? 6 : 3;
}

export function projectsAgentWorkBudget(input: {
  stage?: AgentInvocationStage; plan?: AgentActionPlan; conversationMessageId?: string; peerQuestion?: unknown;
}): boolean {
  if (input.conversationMessageId || input.peerQuestion) return false;
  if (["assessment", "selection", "assessment_and_selection"].includes(input.stage ?? "")) return true;
  if (input.stage !== "authoring") return false;
  return ["start_session", "continue_session", "delegate_agent"].includes(input.plan?.action ?? "");
}

export function projectAgentWorkBudget(state: AgentState, mission: AgentMission, agent: AgentRecord) {
  const latest = [...state.attempts].reverse().find(attempt => attempt.missionId === mission.id &&
    attempt.agentId === agent.id && attempt.status === "settled");
  return {
    kind: "agent_work_budget_v1", authority: "canonical_resource_limits", addsUserIntent: false, grantsPermissions: false,
    missionId: mission.id, executionPolicy: agent.definition.executionPolicy,
    remaining: {
      workRounds: Math.max(0, mission.limits.maxAttempts - mission.usage.attempts),
      modelCalls: Math.max(0, mission.limits.maxModelCalls - mission.usage.modelCalls),
      tokens: Math.max(0, mission.limits.maxTotalTokens - mission.usage.totalTokens),
    },
    roundMeaning: "One new or continued work-session request. A round can contain multiple model calls and tool actions.",
    allowanceMeaning: "A ceiling shared by work, management and replies, not a target to spend. This snapshot is not a live token meter.",
    returnPlanning: { estimatedModelCalls: agentReturnCallEstimate(agent),
      meaning: "Leave room to return the existing evidence and explain limitations. This estimate does not guarantee a provider cost." },
    previousRound: latest ? { attemptId: latest.id, outcome: latest.result?.status ?? "unknown", usage: latest.result?.usage ?? null } : null,
  };
}

/** Stored in the exact immutable work request before dispatch; old requests are never rewritten. */
export function boundedAgentWorkAssignment(text: string, state: AgentState, mission: AgentMission, agent: AgentRecord): string {
  const budget = projectAgentWorkBudget(state, mission, agent);
  const assignment = `${text}\n\nOwning Agent work allowance (resource context, not additional user requirements):\n${JSON.stringify(budget)}\n${AGENT_BOUNDED_WORK_INSTRUCTIONS} Return the useful findings and explicit gaps before the allowance is exhausted; organizing existing evidence does not require another search. The owning Agent decides whether another work round is warranted.`;
  if (assignment.length > AGENT_WORKSPACE_TEXT_LIMIT) throw new AgentStateError("agents_work_assignment_too_long");
  return assignment;
}
