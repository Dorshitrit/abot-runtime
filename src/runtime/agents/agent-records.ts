import type { AgentConversationMessage, AgentResponsibilityTrace, AgentWorkAttempt, AgentMailboxRecord } from "./workspace-records.js";
import type { ToolPermissionMode } from "../../capabilities/tool-permission-mode.js";
import type { RequestExecutionPolicyId } from "../../shared/request-execution-policy.js";
import type { AgentDecisionTrace } from "./decision-records.js";
import type { AgentInvocationRecord } from "./invocation-records.js";

export type AgentOnboarding = Readonly<{
  role:"research"|"writing"|"coding"|"planning"|"everyday"|"custom";
  outputs:readonly ("recommendations"|"summaries"|"comparisons"|"drafts"|"plans"|"code")[];
  style:"concise"|"balanced"|"detailed"; asks:readonly ("unclear"|"tradeoffs"|"direction")[];
  updates:"needed"|"milestones"|"brief"; custom:string; notes:string;
  color:"blue"|"sand"|"mint"|"lilac"|"ivory"; budget:"short"|"standard"|"deep"|"custom";
}>;

/** Stored configuration is not a grant. Execution must recheck live authority. */
export type AgentDefinition = Readonly<{
  name: string;
  icon: string;
  basePrompt: string;
  modelProfileId: string;
  executionPolicy: RequestExecutionPolicyId;
  toolPermissionMode: ToolPermissionMode;
  defaultLimits?: AgentMissionLimits;
  onboarding?: AgentOnboarding;
}>;

export type AgentRecord = Readonly<{
  id: string;
  revision: number;
  status: "active" | "archived";
  definition: AgentDefinition;
  createdAt: string;
  updatedAt: string;
}>;

/** Explicit inputs: this foundation deliberately supplies no budget defaults. */
export type AgentMissionLimits = Readonly<{
  maxAttempts: number;
  maxModelCalls: number;
  maxTotalTokens: number;
  maxConsecutiveNoProgress: number;
  maxClarificationRounds: number;
}>;

export type AgentMissionUsage = Readonly<{
  attempts: number;
  modelCalls: number;
  totalTokens: number;
  consecutiveNoProgress: number;
  clarificationRounds: number;
}>;

export type AgentSuccessCriterion = Readonly<{
  id: string;
  description: string;
}>;

export type AgentMissionStatus =
  | "active"
  | "awaiting_user_decision"
  | "cancelled"
  | "completed"
  | "exhausted";

/** Accepted intent and independently accounted Agent responsibility lifecycle. */
export type AgentMission = Readonly<{
  id: string;
  agentId: string;
  revision: number;
  objective: string;
  successCriteria: readonly AgentSuccessCriterion[];
  status: AgentMissionStatus;
  waitingReason: string | null;
  limits: AgentMissionLimits;
  usage: AgentMissionUsage;
  createdAt: string;
  updatedAt: string;
}>;

/** Sessions belong to an agent, never to a mission. This record is not a session creation receipt. */
export type AgentSessionBinding = Readonly<{
  sessionId: string;
  agentId: string;
  purpose: string;
  createdAt: string;
}>;

export type AgentStateChangeKind =
  | "agent_registered"
  | "agent_definition_updated"
  | "agent_deletion_started"
  | "agent_history_erased"
  | "agent_deleted"
  | "agent_archived"
  | "agent_restored"
  | "session_bound"
  | "mission_started"
  | "mission_waiting_for_user"
  | "mission_cancelled"
  | "invocation_reserved"
  | "invocation_settled"
  | "decision_recorded"
  | "agent_workspace_changed";

/** Management history only; model decision traces are a separate later contract. */
export type AgentStateChange = Readonly<{
  sequence: number;
  kind: AgentStateChangeKind;
  agentId: string;
  missionId: string | null;
  sessionId: string | null;
  reason: string;
  at: string;
}>;

export type AgentState = Readonly<{
  schemaVersion: 6;
  deletingAgentIds: readonly string[];
  revision: number;
  agents: readonly AgentRecord[];
  missions: readonly AgentMission[];
  sessions: readonly AgentSessionBinding[];
  changes: readonly AgentStateChange[];
  invocations: readonly AgentInvocationRecord[];
  decisions: readonly AgentDecisionTrace[];
  messages: readonly AgentConversationMessage[];
  attempts: readonly AgentWorkAttempt[];
  responsibility: readonly AgentResponsibilityTrace[];
  mailbox: readonly AgentMailboxRecord[];
}>;

export function createEmptyAgentState(): AgentState {
  return {
    schemaVersion: 6,
    deletingAgentIds: [],
    revision: 0,
    agents: [],
    missions: [],
    sessions: [],
    changes: [],
    invocations: [],
    decisions: [],
    messages: [],
    attempts: [],
    responsibility: [],
    mailbox: [],
  };
}
