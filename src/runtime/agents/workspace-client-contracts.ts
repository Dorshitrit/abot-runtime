import type { AgentNotificationCursor, AgentNotificationPage } from "./notification-attention.js";
import type { AgentAttentionCursor, AgentAttentionPage } from "./attention.js";
import type { AgentApplicationService } from "./application-contracts.js";
import type { FileAgentStateStore } from "./file-store.js";
import type { AgentManagementService } from "./management-contracts.js";
import type { createAgentWorkspaceApprovals } from "./workspace-approvals.js";
import type { AgentScheduleService } from "./schedule-contracts.js";

/** Managed client surface. Recovery, model calls and scheduler ticks belong to the owner. */
export type AgentWorkspaceClient = Readonly<{
  store: Pick<FileAgentStateStore, "read">;
  application: Pick<AgentApplicationService, "snapshot" | "detail" | "refresh" | "send" | "pause" | "steer" | "cancel" | "resolve" | "associatedSessionIds">;
  management: Pick<AgentManagementService, "previewAuthoring" | "register" | "update" | "archive" | "restore">;
  approvals: ReturnType<typeof createAgentWorkspaceApprovals>;
  schedules: Pick<AgentScheduleService, "list" | "create" | "update" | "cancel">;
  deletion: { remove(agentId: string, expectedRevision: number): Promise<void> };
  projection: {
    notifications?(cursor: AgentNotificationCursor, since: number): Promise<AgentNotificationPage>;
    attention(cursors: readonly AgentAttentionCursor[], since: number): Promise<AgentAttentionPage>;
    through(agentId: string, through: string): Promise<readonly string[]>;
    pending(): Promise<readonly { agentId: string; sessionIds: readonly string[] }[]>;
    acknowledge(agentId: string): Promise<void>;
  };
  isBusy(): Promise<boolean>;
  local(command: Record<string, unknown>): Promise<Record<string, unknown>>;
  remote(command: Record<string, unknown>): Promise<Record<string, unknown>>;
}>;

/** Direct owner operations used to admit a remote command without re-entering IPC. */
export type AgentWorkspaceOperations = Omit<AgentWorkspaceClient, "local" | "remote">;
