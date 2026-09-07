import type {
  UpdateSchedulerJobInput,
  SchedulerJob,
  SchedulerRun,
} from "../../../runtime/scheduler/contracts.js";
import type { CreateWebScheduleJobInput } from "../../schedule-creation-contract.js";

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
  getRuntimeStatus(): Promise<Record<string, unknown>>;
  getRuntimeLogs(lines?: number): Promise<Record<string, unknown>>;
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
    readThroughMessageId?: number | null;
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
  postChatMessage(options: {
    text: string;
    attachments: unknown[];
    environmentId?: string;
    sessionId: string;
    agentMode: string;
    toolPermissionMode: string;
    modelPreference?: Record<string, unknown> | null;
  }): Promise<string>;
  loadConfigDashboard(environmentId?: string): Promise<Record<string, unknown>>;
  saveConfigFile(options: {
    environmentId?: string;
    kind: string;
    id: string;
    config: unknown;
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
};
