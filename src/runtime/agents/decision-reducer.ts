import { createHash } from "node:crypto";
import type { AgentMission, AgentRecord, AgentState } from "./agent-records.js";
import type { AgentControllerCommand } from "./controller-commands.js";
import type { AgentDecisionProposal, AgentDecisionTrace } from "./decision-records.js";
import { readAgentDecisionCommand, readAgentDecisionProposal, sameAgentDecisionConfiguration } from "./decision-validation.js";
import type { AgentInvocationRecord } from "./invocation-records.js";
import { AgentStateError } from "./state-error.js";
import type { AgentStateTransition } from "./state-transition.js";

type DecisionCommand = Extract<AgentControllerCommand, { kind: "record_decision" }>;

function parseProposal(json: string): AgentDecisionProposal | null {
  try {
    return readAgentDecisionProposal(JSON.parse(json));
  } catch {
    // Malformed model output is retained as an outcome, never as raw content.
    return null;
  }
}

function exceedsBudget(mission: AgentMission): boolean {
  const { usage, limits } = mission;
  return usage.attempts > limits.maxAttempts || usage.modelCalls > limits.maxModelCalls
    || usage.totalTokens > limits.maxTotalTokens || usage.consecutiveNoProgress > limits.maxConsecutiveNoProgress
    || usage.clarificationRounds > limits.maxClarificationRounds;
}

function rejectionCode(
  state: AgentState,
  command: DecisionCommand,
  agent: AgentRecord,
  mission: AgentMission,
  invocation: AgentInvocationRecord,
  proposal: AgentDecisionProposal | null,
): string | null {
  if (!proposal) return "malformed_proposal";
  if (invocation.status !== "settled") return "invocation_not_settled";
  const stage = invocation.configuration.policy.id === "supervisor-worker-v1" ? "selection" : "assessment_and_selection";
  if (invocation.stage !== stage) return "invocation_stage_not_decisional";
  if (agent.status !== "active") return "agent_inactive";
  if (mission.status !== "active") return "mission_inactive";
  if (agent.revision !== invocation.agentRevision) return "stale_agent_revision";
  if (mission.revision !== invocation.missionRevision) return "stale_mission_revision";
  if (!command.currentConfiguration || !sameAgentDecisionConfiguration(command.currentConfiguration, invocation.configuration))
    return "configuration_changed";
  if (exceedsBudget(mission)) return "budget_exhausted";
  if (state.invocations.some((record) => record.missionId === mission.id && record.status !== "settled"))
    return "usage_pending";
  if (proposal.evidenceIds.length > 0) return "evidence_unavailable";
  const action = proposal.action;
  if (action.kind === "continue_session"
    && !state.sessions.some((session) => session.sessionId === action.sessionId && session.agentId === agent.id))
    return "session_owner_mismatch";
  if (proposal.action.kind !== "ask_user") return "operation_unavailable";
  if (mission.usage.clarificationRounds >= mission.limits.maxClarificationRounds) return "clarification_limit_reached";
  return null;
}

function waitForUser(state: AgentState, mission: AgentMission, proposal: AgentDecisionProposal, at: string): AgentState {
  if (proposal.action.kind !== "ask_user") throw new AgentStateError("agents_decision_action_invalid");
  const updated: AgentMission = {
    ...mission,
    revision: mission.revision + 1,
    status: "awaiting_user_decision",
    waitingReason: proposal.action.question,
    usage: { ...mission.usage, clarificationRounds: mission.usage.clarificationRounds + 1 },
    updatedAt: at,
  };
  return { ...state, missions: state.missions.map((entry) => entry.id === mission.id ? updated : entry) };
}

function matchesRecordedDecision(trace: AgentDecisionTrace, command: DecisionCommand, proposalFingerprint: string): boolean {
  return trace.agentId === command.agentId && trace.invocationId === command.invocationId
    && trace.proposalFingerprint === proposalFingerprint;
}

/** This gate records a bounded proposal and may pause a mission. It never dispatches work. */
export function reduceAgentDecision(state: AgentState, proposed: DecisionCommand, at: string): AgentStateTransition {
  const command = readAgentDecisionCommand(proposed);
  const agent = state.agents.find((entry) => entry.id === command.agentId);
  if (!agent) throw new AgentStateError("agents_agent_not_found");
  const invocation = state.invocations.find((entry) => entry.id === command.invocationId);
  if (!invocation) throw new AgentStateError("agents_invocation_not_found");
  if (invocation.agentId !== agent.id) throw new AgentStateError("agents_invocation_owner_mismatch");
  const mission = state.missions.find((entry) => entry.id === invocation.missionId);
  if (!mission || mission.agentId !== agent.id) throw new AgentStateError("agents_mission_owner_mismatch");
  const proposalFingerprint = `sha256:${createHash("sha256").update(command.proposalJson).digest("hex")}`;
  const existing = state.decisions.find((entry) => entry.id === command.decisionId);
  if (existing && !matchesRecordedDecision(existing, command, proposalFingerprint))
    throw new AgentStateError("agents_decision_replay_conflict");
  if (existing)
    return { state, kind: "decision_recorded", reason: "Decision receipt already retained.", missionId: mission.id, unchanged: true };
  if (state.decisions.some((entry) => entry.invocationId === invocation.id))
    throw new AgentStateError("agents_invocation_decision_exists");
  const proposal = parseProposal(command.proposalJson);
  const rejected = rejectionCode(state, command, agent, mission, invocation, proposal);
  const trace: AgentDecisionTrace = {
    id: command.decisionId, agentId: agent.id, missionId: mission.id, invocationId: invocation.id,
    agentRevision: invocation.agentRevision, missionRevision: invocation.missionRevision,
    configuration: invocation.configuration, proposal, proposalFingerprint,
    outcome: rejected === null ? "accepted" : "rejected", code: rejected ?? "awaiting_user_decision", recordedAt: at,
  };
  const next = rejected === null ? waitForUser(state, mission, proposal!, at) : state;
  return {
    state: { ...next, decisions: [...state.decisions, trace] }, kind: "decision_recorded", missionId: mission.id,
    reason: rejected === null ? "Clarification reserved; mission waits for the user. Delivery is not implied." : `Decision rejected: ${rejected}.`,
  };
}
