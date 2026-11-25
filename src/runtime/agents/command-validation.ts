import { isAgentWorkspaceKind } from "./workspace-commands.js";
import { readAgentWorkspaceCommand } from "./workspace-validation.js";
import type {
  AgentStateCommand,
  AgentStateCommandKind,
} from "./state-commands.js";
import {
  readAgentDefinition,
  readAgentMissionLimits,
  readAgentSuccessCriteria,
  rejectAgentRecord,
  requireAgentFields,
  requireAgentText,
} from "./record-validation.js";
import { readAgentInvocationCommand } from "./invocation-validation.js";
import { readAgentDecisionCommand } from "./decision-validation.js";

const COMMAND_FIELDS: Readonly<
  Partial<Record<AgentStateCommandKind, readonly string[]>>
> = {
  register_agent: ["kind", "agentId", "definition"],
  update_definition: ["kind", "agentId", "definition"],
  begin_agent_deletion: ["kind", "agentId"],
  finish_agent_deletion: ["kind", "agentId"],
  archive_agent: ["kind", "agentId"],
  restore_agent: ["kind", "agentId"],
  bind_session: ["kind", "agentId", "sessionId", "purpose"],
  start_mission: [
    "kind",
    "agentId",
    "missionId",
    "objective",
    "successCriteria",
    "limits",
  ],
  wait_for_user: ["kind", "agentId", "missionId", "reason"],
  cancel_mission: ["kind", "agentId", "missionId", "reason"],
  reserve_invocation: ["kind", "agentId", "missionId", "invocationId", "agentRevision", "missionRevision", "configuration", "stage", "reservedTokens"],
  settle_invocation: ["kind", "agentId", "invocationId", "usage"],
  record_decision: ["kind", "agentId", "invocationId", "decisionId", "proposalJson", "currentConfiguration"],
};

export function readAgentStateCommand(value: unknown): AgentStateCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    rejectAgentRecord("command");
  const kind = (value as Record<string, unknown>).kind;
  if (isAgentWorkspaceKind(kind)) return readAgentWorkspaceCommand(value);
  if (typeof kind !== "string" || !Object.hasOwn(COMMAND_FIELDS, kind))
    rejectAgentRecord("command.kind");
  if (kind === "reserve_invocation" || kind === "settle_invocation")
    return readAgentInvocationCommand(value);
  if (kind === "record_decision") return readAgentDecisionCommand(value);
  const command = requireAgentFields(
    value,
    COMMAND_FIELDS[kind as AgentStateCommandKind]!,
    "command",
  );
  requireAgentText(command.agentId, "command.agentId");
  if (Object.hasOwn(command, "definition"))
    readAgentDefinition(command.definition);
  if (Object.hasOwn(command, "missionId"))
    requireAgentText(command.missionId, "command.missionId");
  if (Object.hasOwn(command, "reason"))
    requireAgentText(command.reason, "command.reason");
  if (kind === "bind_session") {
    requireAgentText(command.sessionId, "command.sessionId");
    requireAgentText(command.purpose, "command.purpose");
  }
  if (kind === "start_mission") {
    requireAgentText(command.objective, "command.objective");
    readAgentSuccessCriteria(command.successCriteria);
    readAgentMissionLimits(command.limits);
  }
  return structuredClone(command) as AgentStateCommand;
}
