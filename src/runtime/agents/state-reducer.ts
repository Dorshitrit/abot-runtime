import { beginAgentDeletion, finishAgentDeletion, wasAgentDeleted } from "./deletion-state.js";
import { isAgentWorkspaceKind, type AgentWorkspaceCommand } from "./workspace-commands.js";
import { reduceAgentWorkspace } from "./workspace-reducer.js";
import type {
  AgentMission,
  AgentRecord,
  AgentState,
  AgentStateChange,
} from "./agent-records.js";
import { readAgentStateCommand } from "./command-validation.js";
import { requireAgentTimestamp } from "./record-validation.js";
import type { AgentStateCommand } from "./state-commands.js";
import { AgentStateError } from "./state-error.js";
import { readAgentState } from "./state-validation.js";
import type { AgentStateTransition } from "./state-transition.js";
import { reduceAgentInvocation } from "./invocation-reducer.js";
import { reduceAgentDecision } from "./decision-reducer.js";

type Transition = AgentStateTransition;

type CommandOf<K extends AgentStateCommand["kind"]> = Extract<
  AgentStateCommand,
  { kind: K }
>;

function hasRegisteredAgent(state: AgentState, agentId: string): boolean {
  return state.agents.some((agent) => agent.id === agentId);
}

function hasRegisteredMission(state: AgentState, missionId: string): boolean {
  return state.missions.some((mission) => mission.id === missionId);
}

function hasBoundSession(state: AgentState, sessionId: string): boolean {
  return state.sessions.some((session) => session.sessionId === sessionId);
}

function requireActiveAgent(state: AgentState, agentId: string): AgentRecord {
  const agent = state.agents.find((entry) => entry.id === agentId);
  if (!agent) throw new AgentStateError("agents_agent_not_found");
  if (agent.status !== "active")
    throw new AgentStateError("agents_agent_archived");
  return agent;
}

function requireArchivedAgent(state: AgentState, agentId: string): AgentRecord {
  const agent = state.agents.find((entry) => entry.id === agentId);
  if (!agent) throw new AgentStateError("agents_agent_not_found");
  if (agent.status !== "archived")
    throw new AgentStateError("agents_agent_not_archived");
  return agent;
}

function hasUnfinishedAgentMission(
  state: AgentState,
  agentId: string,
): boolean {
  return state.missions.some(
    (mission) => mission.agentId === agentId && ["active", "awaiting_user_decision"].includes(mission.status),
  );
}

function replaceAgent(state: AgentState, agent: AgentRecord): AgentState {
  return {
    ...state,
    agents: state.agents.map((entry) =>
      entry.id === agent.id ? agent : entry,
    ),
  };
}

function requireOwnedUnfinishedMission(
  state: AgentState,
  agentId: string,
  missionId: string,
): AgentMission {
  const mission = state.missions.find((entry) => entry.id === missionId);
  if (!mission) throw new AgentStateError("agents_mission_not_found");
  if (mission.agentId !== agentId)
    throw new AgentStateError("agents_mission_owner_mismatch");
  if (["cancelled", "completed", "exhausted"].includes(mission.status))
    throw new AgentStateError("agents_mission_terminal");
  return mission;
}

function registerAgent(
  state: AgentState,
  command: CommandOf<"register_agent">,
  at: string,
): Transition {
  if (hasRegisteredAgent(state, command.agentId))
    throw new AgentStateError("agents_agent_exists");
  const agent: AgentRecord = {
    id: command.agentId,
    revision: 1,
    status: "active",
    definition: command.definition,
    createdAt: at,
    updatedAt: at,
  };
  return {
    state: { ...state, agents: [...state.agents, agent] },
    kind: "agent_registered",
    reason: "Agent registered.",
  };
}

function updateDefinition(
  state: AgentState,
  command: CommandOf<"update_definition">,
  at: string,
): Transition {
  const owner = requireActiveAgent(state, command.agentId);
  if (hasUnfinishedAgentMission(state, owner.id)) throw new AgentStateError("agents_agent_busy");
  const agent = {
    ...owner,
    definition: command.definition,
    revision: owner.revision + 1,
    updatedAt: at,
  };
  return {
    state: replaceAgent(state, agent),
    kind: "agent_definition_updated",
    reason: "Agent definition revised.",
  };
}

function archiveAgent(
  state: AgentState,
  command: CommandOf<"archive_agent">,
  at: string,
): Transition {
  if (command.agentId === "abot") throw new AgentStateError("agents_abot_required");
  const owner = requireActiveAgent(state, command.agentId);
  if (hasUnfinishedAgentMission(state, owner.id))
    throw new AgentStateError("agents_agent_busy");
  const agent = {
    ...owner,
    status: "archived" as const,
    revision: owner.revision + 1,
    updatedAt: at,
  };
  return {
    state: replaceAgent(state, agent),
    kind: "agent_archived",
    reason: "Agent archived; owned records retained.",
  };
}

/** Restoring identity does not resume missions or authorize execution. */
function restoreAgent(
  state: AgentState,
  command: CommandOf<"restore_agent">,
  at: string,
): Transition {
  const owner = requireArchivedAgent(state, command.agentId);
  const agent = {
    ...owner,
    status: "active" as const,
    revision: owner.revision + 1,
    updatedAt: at,
  };
  return {
    state: replaceAgent(state, agent),
    kind: "agent_restored",
    reason: "Agent restored; retained work remains unchanged.",
  };
}

function bindSession(
  state: AgentState,
  command: CommandOf<"bind_session">,
  at: string,
): Transition {
  const owner = requireActiveAgent(state, command.agentId);
  if (hasBoundSession(state, command.sessionId))
    throw new AgentStateError("agents_session_already_bound");
  const binding = {
    sessionId: command.sessionId,
    agentId: owner.id,
    purpose: command.purpose,
    createdAt: at,
  };
  return {
    state: { ...state, sessions: [...state.sessions, binding] },
    kind: "session_bound",
    reason: "Work session ownership recorded.",
    sessionId: command.sessionId,
  };
}

function startMission(
  state: AgentState,
  command: CommandOf<"start_mission">,
  at: string,
): Transition {
  const owner = requireActiveAgent(state, command.agentId);
  if (hasRegisteredMission(state, command.missionId))
    throw new AgentStateError("agents_mission_exists");
  if (hasUnfinishedAgentMission(state, owner.id))
    throw new AgentStateError("agents_agent_busy");
  const mission: AgentMission = {
    id: command.missionId,
    agentId: owner.id,
    revision: 1,
    objective: command.objective,
    successCriteria: command.successCriteria,
    status: "active",
    waitingReason: null,
    limits: command.limits,
    usage: {
      attempts: 0,
      modelCalls: 0,
      totalTokens: 0,
      consecutiveNoProgress: 0,
      clarificationRounds: 0,
    },
    createdAt: at,
    updatedAt: at,
  };
  return {
    state: { ...state, missions: [...state.missions, mission] },
    kind: "mission_started",
    reason: "Explicit mission accepted.",
    missionId: mission.id,
  };
}

function setMissionDisposition(
  state: AgentState,
  command: CommandOf<"wait_for_user" | "cancel_mission">,
  at: string,
): Transition {
  const owner = requireActiveAgent(state, command.agentId);
  const mission = requireOwnedUnfinishedMission(
    state,
    owner.id,
    command.missionId,
  );
  const updated: AgentMission = {
    ...mission,
    revision: mission.revision + 1,
    updatedAt: at,
    status:
      command.kind === "wait_for_user" ? "awaiting_user_decision" : "cancelled",
    waitingReason: command.kind === "wait_for_user" ? command.reason : null,
  };
  return {
    state: {
      ...state,
      missions: state.missions.map((entry) =>
        entry.id === mission.id ? updated : entry,
      ),
    },
    kind:
      command.kind === "wait_for_user"
        ? "mission_waiting_for_user"
        : "mission_cancelled",
    reason: command.reason,
    missionId: mission.id,
  };
}

function applyAgentCommand(
  state: AgentState,
  command: AgentStateCommand,
  at: string,
): Transition {
  if (command.kind === "begin_agent_deletion") return beginAgentDeletion(state, command.agentId, at);
  if (command.kind === "finish_agent_deletion") return finishAgentDeletion(state, command.agentId);
  if (state.deletingAgentIds.includes(command.agentId)) throw new AgentStateError("agents_deletion_pending");
  if (wasAgentDeleted(state, command.agentId)) throw new AgentStateError("agents_agent_not_found");
  if (isAgentWorkspaceKind(command.kind)) return reduceAgentWorkspace(state, command as AgentWorkspaceCommand, at);
  switch (command.kind) {
    case "register_agent":
      return registerAgent(state, command, at);
    case "update_definition":
      return updateDefinition(state, command, at);
    case "archive_agent":
      return archiveAgent(state, command, at);
    case "restore_agent":
      return restoreAgent(state, command, at);
    case "bind_session":
      return bindSession(state, command, at);
    case "start_mission":
      return startMission(state, command, at);
    case "wait_for_user":
    case "cancel_mission":
      return setMissionDisposition(state, command, at);
    case "reserve_invocation":
    case "settle_invocation":
      return reduceAgentInvocation(state, command, at);
    case "record_decision":
      return reduceAgentDecision(state, command, at);
    default: throw new AgentStateError("agents_command_invalid");
  }
}

/** Sole canonical state writer; controller proposals never dispatch runtime work here. */
export function reduceAgentCommand(
  input: AgentState,
  proposed: AgentStateCommand,
  at: string,
): AgentState {
  const state = readAgentState(input);
  const command = readAgentStateCommand(proposed);
  requireAgentTimestamp(at, "command.at");
  if (state.revision === Number.MAX_SAFE_INTEGER)
    throw new AgentStateError("agents_state_revision_exhausted");
  const transition = applyAgentCommand(state, command, at);
  if (transition.unchanged) return state;
  const sequence = state.revision + 1;
  const change: AgentStateChange = {
    sequence,
    kind: transition.kind,
    agentId: command.agentId,
    missionId: transition.missionId ?? null,
    sessionId: transition.sessionId ?? null,
    reason: transition.reason,
    at,
  };
  return readAgentState({
    ...transition.state,
    revision: sequence,
    changes: [...transition.state.changes, change],
  });
}
