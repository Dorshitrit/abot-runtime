import type { AgentWorkspaceCommand } from "./workspace-commands.js";
import type {
  AgentDefinition,
  AgentMissionLimits,
  AgentSuccessCriterion,
} from "./agent-records.js";
import type { AgentControllerCommand } from "./controller-commands.js";

/** Internal management commands, not model decisions or public client authority. */
export type AgentStateCommand =
  | AgentControllerCommand
  | AgentWorkspaceCommand
  | Readonly<{
      kind: "register_agent";
      agentId: string;
      definition: AgentDefinition;
    }>
  | Readonly<{
      kind: "update_definition";
      agentId: string;
      definition: AgentDefinition;
    }>
  | Readonly<{ kind: "begin_agent_deletion"; agentId: string }>
  | Readonly<{ kind: "finish_agent_deletion"; agentId: string }>
  | Readonly<{ kind: "archive_agent"; agentId: string }>
  | Readonly<{ kind: "restore_agent"; agentId: string }>
  | Readonly<{
      kind: "bind_session";
      agentId: string;
      sessionId: string;
      purpose: string;
    }>
  | Readonly<{
      kind: "start_mission";
      agentId: string;
      missionId: string;
      objective: string;
      successCriteria: readonly AgentSuccessCriterion[];
      limits: AgentMissionLimits;
    }>
  | Readonly<{
      kind: "wait_for_user";
      agentId: string;
      missionId: string;
      reason: string;
    }>
  | Readonly<{
      kind: "cancel_mission";
      agentId: string;
      missionId: string;
      reason: string;
    }>;

export type AgentStateCommandKind = AgentStateCommand["kind"];
