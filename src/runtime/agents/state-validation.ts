import { validateDeletionHistory } from "./deletion-state.js";
import { validateAgentWorkspaceIntegrity } from "./workspace-integrity.js";
import { validateAgentWorkspaceState } from "./workspace-validation.js";
import type {
  AgentMission,
  AgentRecord,
  AgentSessionBinding,
  AgentState,
  AgentStateChange,
} from "./agent-records.js";
import {
  readAgentDefinition,
  readAgentMissionLimits,
  readAgentSuccessCriteria,
  rejectAgentRecord,
  requireAgentFields,
  requireAgentInteger,
  requireAgentText,
  requireAgentTimestamp,
} from "./record-validation.js";
import { projectAgentStateSchema } from "./state-schema.js";
import { validateAgentInvocationRecord, validateAgentInvocationState } from "./invocation-validation.js";
import { validateAgentDecisionRecord, validateAgentDecisionState } from "./decision-validation.js";

const CHANGE_KINDS = [
  "agent_registered",
  "agent_deletion_started",
  "agent_deleted",
  "agent_history_erased",
  "agent_definition_updated",
  "agent_archived",
  "agent_restored",
  "session_bound",
  "mission_started",
  "mission_waiting_for_user",
  "mission_cancelled",
  "invocation_reserved",
  "invocation_settled",
  "decision_recorded",
  "agent_workspace_changed",
];

function validateAgentRecord(value: unknown): asserts value is AgentRecord {
  const record = requireAgentFields(
    value,
    ["id", "revision", "status", "definition", "createdAt", "updatedAt"],
    "agent",
  );
  requireAgentText(record.id, "agent.id");
  requireAgentInteger(record.revision, 1, "agent.revision");
  if (!["active", "archived"].includes(record.status as string))
    rejectAgentRecord("agent.status");
  readAgentDefinition(record.definition);
  validateRecordTimes(record);
}

function validateRecordTimes(record: Record<string, unknown>): void {
  requireAgentTimestamp(record.createdAt, "createdAt");
  requireAgentTimestamp(record.updatedAt, "updatedAt");
}

function validateAgentMission(value: unknown): asserts value is AgentMission {
  const record = requireAgentFields(
    value,
    [
      "id",
      "agentId",
      "revision",
      "objective",
      "successCriteria",
      "status",
      "waitingReason",
      "limits",
      "usage",
      "createdAt",
      "updatedAt",
    ],
    "mission",
  );
  for (const key of ["id", "agentId", "objective"])
    requireAgentText(record[key], `mission.${key}`);
  requireAgentInteger(record.revision, 1, "mission.revision");
  if (
    !["active", "awaiting_user_decision", "cancelled", "completed", "exhausted"].includes(
      record.status as string,
    )
  )
    rejectAgentRecord("mission.status");
  if (record.status === "awaiting_user_decision")
    requireAgentText(record.waitingReason, "mission.waitingReason");
  if (
    record.status !== "awaiting_user_decision" &&
    record.waitingReason !== null
  )
    rejectAgentRecord("mission.waitingReason");
  readAgentSuccessCriteria(record.successCriteria);
  readAgentMissionLimits(record.limits);
  const usageFields = [
    "attempts",
    "modelCalls",
    "totalTokens",
    "consecutiveNoProgress",
    "clarificationRounds",
  ];
  const usage = requireAgentFields(record.usage, usageFields, "usage");
  for (const key of usageFields)
    requireAgentInteger(usage[key], 0, `usage.${key}`);
  validateRecordTimes(record);
}

function validateAgentSessionBinding(
  value: unknown,
): asserts value is AgentSessionBinding {
  const record = requireAgentFields(
    value,
    ["sessionId", "agentId", "purpose", "createdAt"],
    "session",
  );
  for (const key of ["sessionId", "agentId", "purpose"])
    requireAgentText(record[key], `session.${key}`);
  requireAgentTimestamp(record.createdAt, "session.createdAt");
}

function validateAgentChange(
  value: unknown,
): asserts value is AgentStateChange {
  const record = requireAgentFields(
    value,
    ["sequence", "kind", "agentId", "missionId", "sessionId", "reason", "at"],
    "change",
  );
  requireAgentInteger(record.sequence, 1, "change.sequence");
  if (!CHANGE_KINDS.includes(record.kind as string))
    rejectAgentRecord("change.kind");
  requireAgentText(record.agentId, "change.agentId");
  requireAgentText(record.reason, "change.reason");
  if (record.missionId !== null)
    requireAgentText(record.missionId, "change.missionId");
  if (record.sessionId !== null)
    requireAgentText(record.sessionId, "change.sessionId");
  const missionChange = [
    "mission_started",
    "mission_waiting_for_user",
    "mission_cancelled",
    "invocation_reserved",
    "invocation_settled",
    "decision_recorded",
    "agent_workspace_changed",
  ].includes(record.kind as string);
  if (missionChange && record.missionId === null)
    rejectAgentRecord("change.mission_required");
  if (!missionChange && record.missionId !== null)
    rejectAgentRecord("change.mission_unexpected");
  if (record.kind === "session_bound" && record.sessionId === null)
    rejectAgentRecord("change.session_required");
  if (record.kind !== "session_bound" && record.sessionId !== null)
    rejectAgentRecord("change.session_unexpected");
  requireAgentTimestamp(record.at, "change.at");
}

function validateStateOwnership(state: AgentState, deletedAgents: ReadonlySet<string>): void {
  const agents = new Map(state.agents.map((agent) => [agent.id, agent]));
  const missions = new Map(
    state.missions.map((mission) => [mission.id, mission]),
  );
  const sessions = new Map(
    state.sessions.map((session) => [session.sessionId, session]),
  );
  if (agents.size !== state.agents.length)
    rejectAgentRecord("agents.duplicate_id");
  if (missions.size !== state.missions.length)
    rejectAgentRecord("missions.duplicate_id");
  if (sessions.size !== state.sessions.length)
    rejectAgentRecord("sessions.duplicate_id");
  const occupied = new Set<string>();
  for (const mission of state.missions) {
    const owner = agents.get(mission.agentId);
    if (!owner) rejectAgentRecord("mission.owner_missing");
    if (["cancelled", "completed", "exhausted"].includes(mission.status)) continue;
    if (owner.status === "archived")
      rejectAgentRecord("mission.owner_archived");
    if (occupied.has(mission.agentId)) rejectAgentRecord("mission.owner_busy");
    occupied.add(mission.agentId);
  }
  for (const session of state.sessions) {
    if (!agents.has(session.agentId))
      rejectAgentRecord("session.owner_missing");
  }
  for (const change of state.changes) {
    if (deletedAgents.has(change.agentId)) continue; // Deletion history has its own strict shape.
    if (!agents.has(change.agentId)) rejectAgentRecord("change.owner_missing");
    if (
      change.missionId !== null &&
      missions.get(change.missionId)?.agentId !== change.agentId
    )
      rejectAgentRecord("change.mission_owner_mismatch");
    if (
      change.sessionId !== null &&
      sessions.get(change.sessionId)?.agentId !== change.agentId
    )
      rejectAgentRecord("change.session_owner_mismatch");
  }
}

/** Unknown versions or corrupt links fail closed; loading never repairs or rewrites facts. */
export function readAgentState(value: unknown): AgentState {
  const record = requireAgentFields(
    projectAgentStateSchema(value),
    ["schemaVersion", "revision", "deletingAgentIds", "agents", "missions", "sessions", "changes", "invocations", "decisions", "messages", "attempts", "responsibility", "mailbox"],
    "state",
  );
  if (record.schemaVersion !== 6) rejectAgentRecord("state.schemaVersion");
  requireAgentInteger(record.revision, 0, "state.revision");
  for (const key of ["agents", "missions", "sessions", "changes", "invocations", "decisions", "messages", "attempts", "responsibility", "mailbox"]) {
    if (!Array.isArray(record[key])) rejectAgentRecord(`state.${key}`);
  }
  for (const agent of record.agents as unknown[]) validateAgentRecord(agent);
  for (const mission of record.missions as unknown[])
    validateAgentMission(mission);
  for (const session of record.sessions as unknown[])
    validateAgentSessionBinding(session);
  for (const change of record.changes as unknown[]) validateAgentChange(change);
  for (const invocation of record.invocations as unknown[]) validateAgentInvocationRecord(invocation);
  for (const decision of record.decisions as unknown[]) validateAgentDecisionRecord(decision);
  const state = record as AgentState;
  if (state.changes.length !== state.revision)
    rejectAgentRecord("state.change_count");
  if (!state.changes.every((change, index) => change.sequence === index + 1))
    rejectAgentRecord("state.change_order");
  const deletedAgents = validateDeletionHistory(state);
  validateStateOwnership(state, deletedAgents);
  validateAgentInvocationState(state);
  validateAgentDecisionState(state);
  validateAgentWorkspaceState(state, deletedAgents);
  validateAgentWorkspaceIntegrity(state);
  return structuredClone(state);
}
