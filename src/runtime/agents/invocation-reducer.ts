import { isDeepStrictEqual } from "node:util";
import type { AgentMission, AgentState } from "./agent-records.js";
import type { AgentInvocationRecord } from "./invocation-records.js";
import {
  isAgentInvocationStageAllowed, matchesAgentInvocationConfiguration, readAgentInvocationCommand,
  type AgentInvocationCommand,
} from "./invocation-validation.js";
import { pausedChatBlock } from "./conversation-availability.js";
import { AgentStateError } from "./state-error.js";
import type { AgentStateTransition } from "./state-transition.js";

type ReserveCommand = Extract<AgentInvocationCommand, { kind: "reserve_invocation" }>;
type SettleCommand = Extract<AgentInvocationCommand, { kind: "settle_invocation" }>;
type ConversationReservation = "conversation" | "completed_follow_up";

function addInvocationUsage(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new AgentStateError("agents_invocation_usage_overflow");
  return result;
}

function matchesReservation(record: AgentInvocationRecord, command: ReserveCommand): boolean {
  if (record.agentId !== command.agentId) return false;
  if (record.missionId !== command.missionId) return false;
  if (record.agentRevision !== command.agentRevision) return false;
  if (record.missionRevision !== command.missionRevision) return false;
  if (record.stage !== command.stage) return false;
  if (record.reservedTokens !== command.reservedTokens) return false;
  return isDeepStrictEqual(record.configuration, command.configuration);
}

function hasConflictingReservation(record: AgentInvocationRecord | undefined, command: ReserveCommand): boolean {
  if (!record) return false;
  return !matchesReservation(record, command);
}

function hasConflictingSettlement(record: AgentInvocationRecord, command: SettleCommand): boolean {
  if (record.status !== "settled") return false;
  return !isDeepStrictEqual(record.usage, command.usage);
}

function unchangedInvocation(state: AgentState, record: AgentInvocationRecord, kind: AgentStateTransition["kind"]): AgentStateTransition {
  return { state, kind, missionId: record.missionId, reason: "Invocation receipt already retained.", unchanged: true };
}

function requireInvocationMission(state: AgentState, agentId: string, missionId: string): AgentMission {
  const mission = state.missions.find((entry) => entry.id === missionId);
  if (!mission) throw new AgentStateError("agents_mission_not_found");
  if (mission.agentId !== agentId) throw new AgentStateError("agents_mission_owner_mismatch");
  return mission;
}

function requireReserveAuthority(state: AgentState, command: ReserveCommand, conversation?: ConversationReservation): AgentMission {
  const agent = state.agents.find((entry) => entry.id === command.agentId);
  if (!agent) throw new AgentStateError("agents_agent_not_found");
  if (agent.status !== "active") throw new AgentStateError("agents_agent_archived");
  const mission = requireInvocationMission(state, agent.id, command.missionId);
  if (mission.status === "awaiting_user_decision" && conversation) {
    const block = pausedChatBlock(state, mission);
    if (block) throw new AgentStateError(block);
  } else if (mission.status !== "active" && !(mission.status === "completed" && conversation === "completed_follow_up"))
    throw new AgentStateError("agents_mission_not_active");
  if (agent.revision !== command.agentRevision) throw new AgentStateError("agents_agent_revision_conflict");
  if (mission.revision !== command.missionRevision && !(conversation === "completed_follow_up" && mission.revision === command.missionRevision + 1))
    throw new AgentStateError("agents_mission_revision_conflict");
  if (!matchesAgentInvocationConfiguration(command.configuration, agent.definition))
    throw new AgentStateError("agents_invocation_configuration_mismatch");
  if (!isAgentInvocationStageAllowed(command.stage, command.configuration))
    throw new AgentStateError("agents_invocation_stage_invalid");
  return mission;
}

function requireInvocationAllowance(state: AgentState, mission: AgentMission, reservedTokens: number): void {
  const unsettled = state.invocations.find((record) => record.missionId === mission.id && record.status !== "settled");
  if (unsettled?.status === "usage_unknown") throw new AgentStateError("agents_invocation_usage_unknown");
  if (unsettled) throw new AgentStateError("agents_invocation_pending");
  if (mission.usage.modelCalls >= mission.limits.maxModelCalls) throw new AgentStateError("agents_model_call_limit_reached");
  if (mission.usage.consecutiveNoProgress >= mission.limits.maxConsecutiveNoProgress)
    throw new AgentStateError("agents_no_progress_limit_reached");
  if (addInvocationUsage(mission.usage.totalTokens, reservedTokens) > mission.limits.maxTotalTokens)
    throw new AgentStateError("agents_token_limit_reached");
}

function replaceMissionUsage(state: AgentState, mission: AgentMission, at: string, usage: AgentMission["usage"]): AgentState {
  return {
    ...state,
    missions: state.missions.map((entry) => entry.id === mission.id ? { ...mission, usage, updatedAt: at } : entry),
  };
}

function reserveInvocation(state: AgentState, command: ReserveCommand, at: string, conversation?: ConversationReservation): AgentStateTransition {
  const existing = state.invocations.find((record) => record.id === command.invocationId);
  if (command.stage === "progress_report" && existing) throw new AgentStateError("agents_progress_already_claimed");
  if (command.stage === "progress_report" && command.invocationId !== `progress:${command.missionId}`) throw new AgentStateError("agents_progress_identity_invalid");
  if (hasConflictingReservation(existing, command)) throw new AgentStateError("agents_invocation_identity_conflict");
  if (existing) return unchangedInvocation(state, existing, "invocation_reserved");
  const mission = requireReserveAuthority(state, command, conversation);
  requireInvocationAllowance(state, mission, command.reservedTokens);
  const record: AgentInvocationRecord = {
    id: command.invocationId, agentId: command.agentId, missionId: mission.id,
    agentRevision: command.agentRevision, missionRevision: command.missionRevision,
    configuration: command.configuration, stage: command.stage, reservedTokens: command.reservedTokens,
    status: "reserved", usage: null, createdAt: at, updatedAt: at,
  };
  const next = replaceMissionUsage(state, mission, at, {
    ...mission.usage, modelCalls: addInvocationUsage(mission.usage.modelCalls, 1),
  });
  return {
    state: { ...next, invocations: [...state.invocations, record] },
    kind: "invocation_reserved", missionId: mission.id,
    reason: "Model-call and token allowance reserved; no invocation is implied.",
  };
}

function canPublishProgressReport(state: AgentState, mission: AgentMission, record: AgentInvocationRecord, workId: string): boolean {
  if (mission.status !== "active" || mission.revision !== record.missionRevision) return false;
  if (!state.agents.some(agent => agent.id === record.agentId && agent.status === "active" && agent.revision === record.agentRevision)) return false;
  return state.attempts.some(attempt => attempt.id === workId && attempt.agentId === record.agentId && attempt.missionId === mission.id &&
    (attempt.status === "claimed" || attempt.status === "running")) ||
    state.mailbox.some(exchange => exchange.id === workId && exchange.agentId === record.agentId && exchange.missionId === mission.id && exchange.status === "pending");
}

function settleInvocation(state: AgentState, command: SettleCommand, at: string): AgentStateTransition {
  const record = state.invocations.find((entry) => entry.id === command.invocationId);
  if (!record) throw new AgentStateError("agents_invocation_not_found");
  if (record.agentId !== command.agentId) throw new AgentStateError("agents_invocation_owner_mismatch");
  const mission = requireInvocationMission(state, command.agentId, record.missionId);
  if (hasConflictingSettlement(record, command)) throw new AgentStateError("agents_invocation_settlement_conflict");
  if (record.status === "settled") return unchangedInvocation(state, record, "invocation_settled");
  if (record.status === "usage_unknown" && command.usage === null)
    return unchangedInvocation(state, record, "invocation_settled");
  if (command.progressReport && record.stage !== "progress_report") throw new AgentStateError("agents_progress_stage_invalid");
  const publicUpdate = command.progressReport && canPublishProgressReport(state, mission, record, command.progressReport.workId)
    ? command.progressReport.text : undefined;
  const settled: AgentInvocationRecord = {
    ...(publicUpdate ? { publicUpdate } : {}),
    ...record, status: command.usage === null ? "usage_unknown" : "settled", usage: command.usage, updatedAt: at,
  };
  const next = replaceMissionUsage(state, mission, at, {
    ...mission.usage, totalTokens: addInvocationUsage(mission.usage.totalTokens, command.usage?.totalTokens ?? 0),
  });
  return {
    state: { ...next, invocations: state.invocations.map((entry) => entry.id === record.id ? settled : entry) },
    kind: "invocation_settled", missionId: mission.id,
    reason: command.usage === null ? "Invocation usage is unknown; its token reservation is retained." : "Invocation usage recorded without changing mission intent.",
  };
}

/** The conversation reducer has already bound this reservation to its exact user message and revision. */
export function reserveBoundConversationReply(state: AgentState, reservation: Omit<ReserveCommand, "kind" | "stage">, at: string, completedFollowUp: boolean): AgentStateTransition {
  return reserveInvocation(state, {...reservation, kind: "reserve_invocation", stage: "authoring"}, at, completedFollowUp ? "completed_follow_up" : "conversation");
}

/** Accounting is trusted runtime input, separate from model-authored decisions. */
export function reduceAgentInvocation(state: AgentState, proposed: AgentInvocationCommand, at: string): AgentStateTransition {
  const command = readAgentInvocationCommand(proposed);
  if (command.kind === "reserve_invocation") return reserveInvocation(state, command, at);
  return settleInvocation(state, command, at);
}
