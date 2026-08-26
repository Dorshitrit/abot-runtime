import type { AgentMode } from "../shared/types.js";

import type { RuntimeAttachmentReference } from "../shared/attachments.js";
import type { SessionMemoryCheckpoint } from "./memory/contracts.js";

export type SessionMessageRole = "user" | "assistant";
export type SessionMessageSource = "user" | "request" | "agent_bridge" | "cron";
export type SessionMessageTaskType = string;
export type SessionMessageGrounding = "conversation" | "tool_observation";
export type ToolObservationKind =
  | "stable_fact"
  | "volatile_external"
  | "task_result";
export type ToolObservationCarryPolicy = "always" | "never";
export type AuthoritativePlannedWorkTaskResultRole =
  | "authoritative_project_handoff"
  | "authoritative_planned_work_handoff_v1";
export type ToolObservationTaskResultRole =
  | AuthoritativePlannedWorkTaskResultRole
  | "supplemental_follow_up";
export type SessionThinkingTraceStatus =
  | "completed"
  | "timeout"
  | "aborted"
  | "error";

export type SessionArtifactPathInput = {
  target: string;
  sourceRequestId: string;
  sourceExecutionId: string;
};

export type SessionArtifactPath = SessionArtifactPathInput & {
  createdAt: string;
  updatedAt: string;
};

export type SessionMessageObservationMeta = {
  kind: ToolObservationKind;
  carryPolicy: ToolObservationCarryPolicy;
  taskResultRole?: ToolObservationTaskResultRole;
};

export type SessionContextEntryKind = "tool_observation";

export type SessionContextEntry = {
  id: string;
  kind: SessionContextEntryKind;
  content: string;
  createdAt: string;
  requestId?: string;
  observationMeta: SessionMessageObservationMeta;
};

export type SessionThinkingTraceEntry = {
  sequence: number;
  step: string;
  status: SessionThinkingTraceStatus;
  text: string;
};

export type SessionRequestStatus = "streaming" | "completed" | "failed";

export type SessionRuntimeEvent = {
  seqNo: number;
  type: string;
  requestId: string;
  timestamp: string;
  payload: Record<string, unknown>;
};

export type SessionRequestRecord = {
  requestId: string;
  sessionId: string;
  status: SessionRequestStatus;
  createdAt: string;
  updatedAt: string;
  lastSeqNo: number;
  events: SessionRuntimeEvent[];
};

export type SessionRequestFinalState =
  | {
      status: "completed";
      output: unknown;
      completedAt: number;
    }
  | {
      status: "failed";
      error: unknown;
      completedAt: number;
    };

export type SessionRequestReplay = {
  requestId: string;
  sessionId: string;
  events: Record<string, unknown>[];
  finalState: SessionRequestFinalState | null;
};

export type SessionListItem = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview: string;
  lastMessageAt: number | null;
  latestMessageId: string | number | null;
  latestAssistantMessageId: string | number | null;
};

export type SessionListResult = {
  sessions: SessionListItem[];
  nextCursor: string | null;
};

export type SessionSnapshotMessage = {
  id: string | number;
  sessionId: string;
  role: SessionMessageRole;
  text: string;
  source: SessionMessageSource;
  createdAt: number;
  requestId: string | null;
  cronJobId: string | null;
  cronTitle: string | null;
  triggerType: string | null;
  attachments?: RuntimeAttachmentReference[];
};

export type SessionSnapshotRequest = {
  requestId: string;
  sessionId: string;
  status: SessionRequestStatus;
  createdAt: number;
  updatedAt: number;
  lastSeqNo: number;
  events: Record<string, unknown>[];
  finalState: SessionRequestFinalState | null;
};

export type SessionSnapshot = {
  sessionId: string;
  title: string;
  messages: SessionSnapshotMessage[];
  requests: SessionSnapshotRequest[];
  nextCursor: string | null;
};

export type SessionDeleteResult = {
  sessionId: string;
  deleted: boolean;
  deletedMessages: number;
  deletedRequests: number;
};

export type SessionMessagesClearResult = {
  sessionId: string;
  cleared: boolean;
  deletedMessages: number;
  deletedRequests: number;
  updatedAt: number;
};

export type SessionMessageDeleteResult = {
  sessionId: string;
  messageId: string;
  deleted: boolean;
  updatedAt: number;
  deletedRequestId?: string;
  deletedRequestEvents?: number;
};

export type SessionMessage = {
  id: string;
  role: SessionMessageRole;
  content: string;
  createdAt: string;
  source?: SessionMessageSource;
  taskType?: SessionMessageTaskType;
  requestId?: string;
  cronJobId?: string;
  cronTitle?: string;
  triggerType?: string;
  grounding?: SessionMessageGrounding;
  observationMeta?: SessionMessageObservationMeta;
  observationContent?: string;
  thinkingTrace?: SessionThinkingTraceEntry[];
  attachments?: RuntimeAttachmentReference[];
};

export type SessionRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastAgentMode: AgentMode;
  runtimeModeId?: string;
  messageCount: number;
  messages: SessionMessage[];
  artifactPaths?: SessionArtifactPath[];
  contextEntries?: SessionContextEntry[];
  requests?: SessionRequestRecord[];
  sessionMemoryCheckpoint?: SessionMemoryCheckpoint;
};
