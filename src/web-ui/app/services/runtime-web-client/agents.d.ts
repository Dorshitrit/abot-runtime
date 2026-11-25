import type { AgentAuthoringInput, AgentAuthoringPreview } from "../../../../runtime/agents/authoring.js";
import type { SessionSnapshot } from "../../../../sessions/types.js";
import type { AgentScheduleInput, AgentScheduleRecord, AgentScheduleUpdate } from "../../../../runtime/agents/schedule-contracts.js";
import type { AgentRecord, AgentMissionLimits } from "../../../../runtime/agents/agent-records.js";
import type { AgentDefinitionInput } from "../../../../runtime/agents/management-contracts.js";
import type { AgentApplicationStatus } from "../../../../runtime/agents/application-contracts.js";
import type { projectRemoteAgentDetail } from "../../../../runtime/agents/remote-workspace-view.js";
import type { agentSessionSummaries } from "../../../../runtime/agents/workspace-public-view.js";
type AgentView = Awaited<ReturnType<typeof projectRemoteAgentDetail>>;
export type AgentWorkspaceDetail = AgentView & { sessions: ReturnType<typeof agentSessionSummaries>; limits: AgentMissionLimits | null };
export type AgentApproval = AgentWorkspaceDetail["approvals"][number];
type AgentMutationResult = AgentWorkspaceDetail | { acknowledged: true; needsRefetch: true; targetAgentId: string; revision?: number };
export type AgentWorkspaceCatalog = { revision: number; agents: (AgentRecord & { isDeleting?: boolean; sessionCount: number; workStatus: AgentApplicationStatus; hasWork: boolean; thinkingSince: string | null; mission: AgentView["mission"]; activity: string | null; latestAgentMessage: string | null; latestWorkUpdate: AgentWorkspaceDetail["updates"][number] | null; recentWorkUpdates?: AgentWorkspaceDetail["updates"]; latestUnreadReply: AgentWorkspaceDetail["updates"][number] | null; limits: AgentMissionLimits | null })[] };
export type AgentConfigurationInput = { authoring: AgentAuthoringInput; expectedRevision: number } | { definition: AgentDefinitionInput; limits: AgentMissionLimits; onboarding?: Record<string, unknown>; expectedRevision: number };
export interface AgentRequests {
  supportsAgents(): boolean;
  previewAgentAuthoring(input: { authoring: Partial<Omit<AgentAuthoringInput, "onboarding">> & {onboarding?: Partial<AgentAuthoringInput["onboarding"]>}; targetAgentId?: string }, environmentId?: string): Promise<{preview: AgentAuthoringPreview}>;
  listAgents(environmentId?: string): Promise<AgentWorkspaceCatalog>;
  getAgent(id: string, environmentId?: string): Promise<AgentWorkspaceDetail>;
  readAgentReplies(id: string, through: string, environmentId?: string): Promise<{ ok: boolean }>;
  getAgentSession(id: string, sessionId: string, environmentId?: string): Promise<{ session: SessionSnapshot | null }>;
  listAgentSchedules(id: string, environmentId?: string): Promise<{ schedules: AgentScheduleRecord[] }>;
  createAgentSchedule(id: string, input: Omit<AgentScheduleInput, "agentId">, environmentId?: string): Promise<{ schedule: AgentScheduleRecord }>;
  updateAgentSchedule(id: string, scheduleId: string, input: AgentScheduleUpdate & {expectedRevision: number}, environmentId?: string): Promise<{schedule: AgentScheduleRecord}>;
  cancelAgentSchedule(id: string, scheduleId: string, input: {expectedRevision: number}, environmentId?: string): Promise<{schedule: AgentScheduleRecord}>;
  createAgent(input: AgentConfigurationInput, environmentId?: string): Promise<AgentMutationResult>;
  updateAgent(id: string, input: AgentConfigurationInput, environmentId?: string): Promise<AgentMutationResult>;
  deleteAgent(id: string, input: {expectedRevision: number}, environmentId?: string): Promise<{ok: true}>;
  sendAgentMessage(id: string, input: { text: string; clientMessageId: string; intent: "auto" | "task" | "message"; limits: AgentMissionLimits }, environmentId?: string): Promise<AgentMutationResult>;
  actOnAgent(id: string, input: { action: "cancel" | "resume" | "pause" | "steer" | "archive" | "restore"; expectedRevision?: number; text?: string; limits?: AgentMissionLimits }, environmentId?: string): Promise<AgentMutationResult>;
  decideAgentApproval(id: string, input: { approvalId: string; approved: boolean; generation?: string; waitId?: string; revision?: number; commandId?: string }, environmentId?: string): Promise<AgentMutationResult>;
}
export function createAgentRequests(options: {
  requestApi(path: string, options?: RequestInit): Promise<unknown>;
  getConfig(): Record<string, unknown> | null;
  getEnvironmentId(): string;
}): AgentRequests;
