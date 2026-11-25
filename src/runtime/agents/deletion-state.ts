import type { AgentState, AgentStateChange } from "./agent-records.js";
import type { AgentStateCommand } from "./state-commands.js";
import type { AgentStateTransition } from "./state-transition.js";
import { rejectAgentRecord, requireAgentText } from "./record-validation.js";
import { AgentStateError } from "./state-error.js";
import { isAgentMissionOpen } from "./workspace-state.js";

const startedReason = "Agent deletion started.";
const deletedReason = "Agent deleted.";
const erasedReason = "Agent history removed.";

export function wasAgentDeleted(state: AgentState, agentId: string): boolean {
  return state.changes.some(change => change.kind === "agent_deleted" && change.agentId === agentId);
}

export function isReplayedAgentDeletion(state: AgentState, command: AgentStateCommand): boolean {
  if (command.kind !== "begin_agent_deletion" && command.kind !== "finish_agent_deletion") return false;
  if (wasAgentDeleted(state, command.agentId)) return true;
  return command.kind === "begin_agent_deletion" && state.deletingAgentIds.includes(command.agentId);
}

/** Unsettled external effects must stay addressable through their original owner. */
function hasUnresolvedAgentReceipts(state: AgentState, agentId: string): boolean {
  // A prepared request cannot dispatch without a new claim. A settled request is terminal even without usage.
  // Private model calls cannot run tools and every subsequent action must pass the owner's admission fence.
  if (state.attempts.some(attempt => attempt.agentId === agentId &&
      attempt.status !== "prepared" && attempt.status !== "settled")) return true;
  return state.mailbox.some(exchange => exchange.recipientAgentId === agentId &&
    (exchange.status !== "answered" || !exchange.outcome || !exchange.usage ||
      exchange.clarifications?.some(item => item.status === "reserved" || item.status === "unknown")));
}

export function beginAgentDeletion(state: AgentState, agentId: string, at: string): AgentStateTransition {
  if (agentId === "abot") throw new AgentStateError("agents_abot_required");
  if (state.deletingAgentIds.includes(agentId) || wasAgentDeleted(state, agentId))
    return {state, kind:"agent_deletion_started", reason:startedReason, unchanged:true};
  const owner = state.agents.find(agent => agent.id === agentId);
  if (!owner) throw new AgentStateError("agents_agent_not_found");
  if (state.missions.some(mission => mission.agentId === agentId && isAgentMissionOpen(mission)))
    throw new AgentStateError("agents_agent_busy");
  if (hasUnresolvedAgentReceipts(state, agentId)) throw new AgentStateError("agents_deletion_unresolved");
  const archived = {...owner, status:"archived" as const, revision:owner.revision + 1, updatedAt:at};
  return {kind:"agent_deletion_started", reason:startedReason, state:{
    ...state, agents:state.agents.map(agent => agent.id === agentId ? archived : agent),
    deletingAgentIds:[...state.deletingAgentIds, agentId],
  }};
}

export function finishAgentDeletion(state: AgentState, agentId: string): AgentStateTransition {
  if (agentId === "abot") throw new AgentStateError("agents_abot_required");
  if (wasAgentDeleted(state, agentId)) return {state, kind:"agent_deleted", reason:deletedReason, unchanged:true};
  if (!state.deletingAgentIds.includes(agentId)) throw new AgentStateError("agents_deletion_not_started");
  const otherOwner = (entry: {agentId: string}) => entry.agentId !== agentId;
  return {kind:"agent_deleted", reason:deletedReason, state:{
    ...state, deletingAgentIds:state.deletingAgentIds.filter(id => id !== agentId),
    agents:state.agents.filter(agent => agent.id !== agentId),
    missions:state.missions.filter(otherOwner), sessions:state.sessions.filter(otherOwner),
    messages:state.messages.filter(otherOwner), attempts:state.attempts.filter(otherOwner),
    invocations:state.invocations.filter(otherOwner), decisions:state.decisions.filter(otherOwner),
    responsibility:state.responsibility.filter(otherOwner),
    mailbox:state.mailbox.map(exchange => {
      if (exchange.recipientAgentId !== agentId || !exchange.clarifications) return exchange;
      const {clarifications, ...parentReceipt} = exchange;
      return parentReceipt;
    }),
    changes:state.changes.map((change): AgentStateChange => otherOwner(change) ? change : {
      sequence:change.sequence, kind:"agent_history_erased", agentId, at:change.at,
      missionId:null, sessionId:null, reason:erasedReason,
    }),
  }};
}

/** The deletion receipt preserves sequence numbers while removing private history and preventing identity reuse. */
export function validateDeletionHistory(state: AgentState): ReadonlySet<string> {
  const pending = state.deletingAgentIds;
  if (!Array.isArray(pending) || new Set(pending).size !== pending.length) rejectAgentRecord("state.deletingAgentIds");
  const lastChanges = new Map<string, AgentStateChange>();
  const removed = new Set<string>();
  for (const change of state.changes) {
    if (removed.has(change.agentId)) rejectAgentRecord("deletion.after_final_receipt");
    if (change.kind === "agent_deleted") {
      if (change.agentId === "abot" || change.reason !== deletedReason ||
          lastChanges.get(change.agentId)?.kind !== "agent_history_erased") rejectAgentRecord("deletion.final_receipt");
      removed.add(change.agentId);
    }
    if (change.kind === "agent_history_erased" && change.reason !== erasedReason) rejectAgentRecord("deletion.erased_reason");
    if (change.kind === "agent_deletion_started" && change.reason !== startedReason) rejectAgentRecord("deletion.start_reason");
    lastChanges.set(change.agentId, change);
  }
  for (const id of pending) {
    requireAgentText(id, "deletion.agentId");
    if (id === "abot" || !state.agents.some(agent => agent.id === id && agent.status === "archived") ||
        lastChanges.get(id)?.kind !== "agent_deletion_started" || hasUnresolvedAgentReceipts(state, id))
      rejectAgentRecord("deletion.pending_owner");
  }
  for (const change of state.changes) {
    if (change.kind === "agent_deletion_started" && !pending.includes(change.agentId)) rejectAgentRecord("deletion.missing_intent");
    if (change.kind === "agent_history_erased" && !removed.has(change.agentId)) rejectAgentRecord("deletion.missing_receipt");
    if (removed.has(change.agentId) && change.kind !== "agent_history_erased" && change.kind !== "agent_deleted")
      rejectAgentRecord("deletion.retained_owner_history");
  }
  if (state.agents.some(agent => removed.has(agent.id))) rejectAgentRecord("deletion.retained_profile");
  return removed;
}
