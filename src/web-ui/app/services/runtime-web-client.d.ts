import type { NotificationRequests } from "./runtime-web-client/notifications.js";
import type { ProjectRequests } from "./runtime-web-client/projects.js";
import type { ToolApprovalRequests } from "./runtime-web-client/tool-approvals.js";
import type { ConversationFileClient } from "./runtime-web-client/conversation-files.js";
import type { ModelRemovalInput } from "../../local-runtime/model-removal.js";
import type { ModelSetupInput } from "../../local-runtime/model-setup-input.js";
import type { SetupEmbeddingInput } from "../../local-runtime/setup-embedding-input.js";
import type {
  UpdateSchedulerJobInput,
  SchedulerJob,
  SchedulerRun,
} from "../../../runtime/scheduler/contracts.js";
import type { CreateWebScheduleJobInput } from "../../schedule-creation-contract.js";
import type { LearningCandidateRecord } from "../../../runtime/long-term-memory/maturation/contracts.js";
import type {
  LearningBatch,
  LearningBatchSummary,
  PassiveLearningPreferences,
  PassiveLearningStatus,
} from "../../../runtime/passive-learning/contracts.js";

export declare function parseJsonResponseText(
  text: string,
  context: string,
): Record<string, unknown>;

export declare class RuntimeWebClientError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly payload: unknown;

  constructor(
    message: string,
    options?: {
      status?: number;
      code?: string;
      payload?: unknown;
    },
  );
}

export type LongTermMemoryRecord = Readonly<{
  id: string;
  content: string;
  tags: readonly string[];
  origin: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}>;

export type LongTermMemoryPage = Readonly<{
  items: readonly LongTermMemoryRecord[];
  total: number;
  status?: Readonly<{
    enabled: boolean;
    available: boolean;
  }>;
}>;

export type LongTermMemoryRecordResponse = Readonly<{
  record: LongTermMemoryRecord;
}>;

export type RuntimeAvailability =
  | { status: "ready" }
  | {
      status: "setup_required";
      code: "runtime_configuration_required";
      message: string;
      recovery?: "configuration";
    };

export type RuntimeModelCatalogResponse = Record<string, unknown> & {
  defaultProfileId: string;
  profiles: Record<string, unknown>[];
  availability: RuntimeAvailability;
};

export declare function createRuntimeWebClient(options: {
  getConfig: () => Record<string, unknown> | null;
  getEnvironmentId: () => string;
  fetchImpl?: typeof fetch;
  origin?: string;
}): {
  supportsNotifications: NotificationRequests["supportsNotifications"];
  listNotifications: NotificationRequests["listNotifications"];
  markNotificationsRead: NotificationRequests["markNotificationsRead"];
  saveNotificationPreferences: NotificationRequests["saveNotificationPreferences"];
  supportsToolApprovals: ToolApprovalRequests["supportsToolApprovals"];
  listToolApprovals: ToolApprovalRequests["listToolApprovals"];
  decideToolApproval: ToolApprovalRequests["decideToolApproval"];
  supportsSystemHostConnection(): boolean;
  getSystemHostConnection(): Promise<Record<string, unknown>>;
  connectLocalSystemHost(): Promise<Record<string, unknown>>;
  downloadSystemHostSetup(
    platform: "windows" | "macos" | "linux",
    options?: { purpose?: "learning" },
  ): Promise<Record<string, unknown>>;
  createSystemHostPairing(): Promise<Record<string, unknown>>;
  revokeSystemHostConnection(): Promise<Record<string, unknown>>;
  supportsProjects: ProjectRequests["supportsProjects"];
  listProjects: ProjectRequests["listProjects"];
  browseProjectFolders: ProjectRequests["browseProjectFolders"];
  createProject: ProjectRequests["createProject"];
  createProjectSession: ProjectRequests["createProjectSession"];
  getRuntimeSetup(environmentId?: string): Promise<Record<string, unknown>>;
  saveRuntimeSetup(
    input: {
      provider: string;
      model: string;
      baseUrl?: string;
      apiKey?: string;
      deferActivation?: boolean;
    },
    environmentId?: string,
  ): Promise<Record<string, unknown>>;
  saveRuntimeSetupEmbedding(
    input: SetupEmbeddingInput,
    environmentId?: string,
  ): Promise<Record<string, unknown>>;
  getRuntimePlugins(environmentId?: string): Promise<Record<string, unknown>>;
  setRuntimePlugin(
    input: { pluginId: string; capabilityId?: string; enabled: boolean },
    environmentId?: string,
  ): Promise<Record<string, unknown>>;
  applyRuntimeConfiguration(
    environmentId?: string,
  ): Promise<Record<string, unknown>>;
  supportsSchedules(): boolean;
  listSchedules(environmentId?: string): Promise<{ jobs: SchedulerJob[] }>;
  getSchedule(
    jobId: string,
    environmentId?: string,
  ): Promise<{ job: SchedulerJob }>;
  listScheduleRuns(
    jobId: string,
    environmentId?: string,
    page?: { cursor?: string; limit?: number },
  ): Promise<{ runs: SchedulerRun[]; nextCursor: string | null }>;
  listRecentScheduleRuns(
    environmentId?: string,
    page?: { cursor?: string; limit?: number },
  ): Promise<{ runs: SchedulerRun[]; nextCursor: string | null }>;
  createSchedule(
    input: CreateWebScheduleJobInput,
    environmentId?: string,
  ): Promise<{ job: SchedulerJob }>;
  updateSchedule(
    jobId: string,
    input: UpdateSchedulerJobInput,
    environmentId?: string,
  ): Promise<{ job: SchedulerJob }>;
  scheduleAction(
    jobId: string,
    action: "pause" | "resume" | "cancel" | "run-now",
    environmentId?: string,
  ): Promise<Record<string, unknown>>;
  supportsConversationFiles(): boolean;
  loadConversationFile: ConversationFileClient["loadConversationFile"];
  openConversationFile: NonNullable<
    ConversationFileClient["openConversationFile"]
  >;
  conversationFileUrl: ConversationFileClient["conversationFileUrl"];
  getRuntimeStatus(environmentId?: string): Promise<Record<string, unknown>>;
  getRuntimeLogs(lines?: number, environmentId?: string): Promise<Record<string, unknown>>;
  getSystemHealth(): Promise<Record<string, unknown>>;
  listModels(environmentId?: string): Promise<RuntimeModelCatalogResponse>;
  getAgentMode(environmentId?: string): Promise<Record<string, unknown>>;
  setAgentMode(
    mode: string,
    environmentId?: string,
  ): Promise<Record<string, unknown>>;
  attachmentPreviewUrl(options: {
    environmentId: string;
    sessionId: string;
    storageRef: string;
    id: string;
    mimeType: string;
  }): string;
  deleteAttachment(options: {
    environmentId: string;
    sessionId: string;
    storageRef: string;
    id: string;
    mimeType: string;
  }): Promise<void>;
  uploadAttachment(options: {
    environmentId: string;
    sessionId: string;
    name: string;
    mimeType: string;
    file: Blob;
  }): Promise<Record<string, unknown>>;
  loadWebConfig(): Promise<Record<string, unknown>>;
  listSessions(environmentId?: string): Promise<Record<string, unknown>>;
  loadSession(
    sessionId: string,
    environmentId?: string,
  ): Promise<Record<string, unknown>>;
  markSessionRead(options: {
    sessionId: string;
    environmentId?: string;
    readThroughMessageId?: number | string | null;
    readThroughRequestId?: string;
  }): Promise<Record<string, unknown>>;
  clearSessionMessages(
    sessionId: string,
    environmentId?: string,
  ): Promise<Record<string, unknown>>;
  deleteSession(
    sessionId: string,
    environmentId?: string,
  ): Promise<Record<string, unknown>>;
  fetchRequestEvents(options: {
    requestId: string;
    afterSeq?: number;
    environmentId?: string;
  }): Promise<unknown[]>;
  stopChatRequest(options: {
    requestId: string;
    sessionId: string;
    environmentId?: string;
  }): Promise<{ accepted: boolean; reason?: string }>;
  postChatMessage(options: {
    text: string;
    attachments: unknown[];
    environmentId?: string;
    sessionId: string;
    agentMode: string;
    toolPermissionMode: string;
    modelPreference?: Record<string, unknown> | null;
  }): Promise<string>;
  loadModelSetup(environmentId?: string): Promise<Record<string, unknown>>;
  addRuntimeModel(
    input: ModelSetupInput,
    environmentId?: string,
  ): Promise<Record<string, unknown>>;
  removeRuntimeModel(
    input: ModelRemovalInput,
    environmentId?: string,
  ): Promise<Record<string, unknown>>;
  loadConfigDashboard(
    environmentId?: string,
    options?: { settled?: boolean },
  ): Promise<Record<string, unknown>>;
  saveConfigFile(options: {
    environmentId?: string;
    kind: string;
    id: string;
    config: unknown;
    expectedRevision?: string;
  }): Promise<Record<string, unknown>>;
  loadLongTermMemoryStatus(
    environmentId?: string,
  ): Promise<Record<string, unknown>>;
  discoverLongTermMemoryModels(options: {
    environmentId?: string;
    providerId: string;
  }): Promise<Record<string, unknown>>;
  enableLongTermMemory(options: {
    environmentId?: string;
    providerId: string;
    model: string;
    profileId?: string;
    emitClientEvents: boolean;
  }): Promise<Record<string, unknown>>;
  disableLongTermMemory(
    environmentId?: string,
  ): Promise<Record<string, unknown>>;
  listLongTermMemories(options?: {
    environmentId?: string;
    limit?: number;
    offset?: number;
    origin?: "passive_observation";
    signal?: AbortSignal;
  }): Promise<LongTermMemoryPage>;
  searchLongTermMemories(options: {
    environmentId?: string;
    query: string;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }): Promise<LongTermMemoryPage>;
  createLongTermMemory(options: {
    environmentId?: string;
    content: string;
    tags: readonly string[];
  }): Promise<LongTermMemoryRecordResponse>;
  updateLongTermMemory(options: {
    environmentId?: string;
    id: string;
    content: string;
    tags: readonly string[];
    expectedUpdatedAt: string;
  }): Promise<LongTermMemoryRecordResponse>;
  deleteLongTermMemory(options: {
    environmentId?: string;
    id: string;
  }): Promise<Record<string, unknown>>;
  loadPassiveLearning(
    environmentId?: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ ok: true; status: PassiveLearningStatus }>;
  configurePassiveLearning(
    input: Partial<PassiveLearningPreferences>,
    environmentId?: string,
  ): Promise<{ ok: true; status: PassiveLearningStatus }>;
  restartPassiveLearningCollection(
    environmentId?: string,
  ): Promise<{ ok: true; status: PassiveLearningStatus }>;
  clearPassiveLearningPending(
    environmentId?: string,
  ): Promise<{ ok: true; status: PassiveLearningStatus }>;
  listPassiveLearningCandidates(
    environmentId?: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ ok: true; items: Omit<LearningCandidateRecord, "embedding">[] }>;
  dismissPassiveLearningProposal(
    id: string,
    environmentId?: string,
  ): Promise<{ ok: true }>;
  listPassiveLearningBatches(
    environmentId?: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ ok: true; items: LearningBatchSummary[] }>;
  loadPassiveLearningBatch(
    id: string,
    environmentId?: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ ok: true; batch: LearningBatch }>;
};
