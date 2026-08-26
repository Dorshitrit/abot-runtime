import type { AgentMode } from "../shared/types.js";
import { buildContextBuckets, buildContextWindow } from "./context-window.js";
import { SessionService } from "./session-service.js";
import type { SessionMemoryCheckpointCommit } from "./memory/contracts.js";
import type {
  SessionArtifactPathInput,
  SessionContextEntryKind,
  SessionMessageGrounding,
  SessionMessageObservationMeta,
  SessionMessageRole,
  SessionMessageSource,
  SessionMessageTaskType,
  SessionThinkingTraceEntry,
} from "./types.js";

export type { SessionArtifactPath, SessionArtifactPathInput } from "./types.js";

const sessionService = new SessionService();

export { buildContextBuckets, buildContextWindow };

export function getOrCreateSession(sessionId: string) {
  return sessionService.getOrCreateSession(sessionId);
}

export function getAllSessions() {
  return sessionService.getAllSessions();
}

export function listSessions(params?: {
  limit?: number;
  cursor?: string | null;
}) {
  return sessionService.listSessions(params);
}

export function getSessionById(sessionId: string) {
  return sessionService.getSessionById(sessionId);
}

export function getSessionSnapshot(
  sessionId: string,
  options?: {
    afterMessageId?: string | number | null;
    includeRequests?: boolean;
  },
) {
  return sessionService.getSessionSnapshot(sessionId, options);
}

export function updateSessionTitle(sessionId: string, title: string) {
  return sessionService.updateSessionTitle(sessionId, title);
}

export function updateSessionRuntimeMode(
  sessionId: string,
  runtimeModeId: string | null,
) {
  return sessionService.updateSessionRuntimeMode(sessionId, runtimeModeId);
}

export function getRequestReplayById(requestId: string, afterSeq = 0) {
  return sessionService.getRequestReplayById(requestId, afterSeq);
}

export function deleteSession(sessionId: string) {
  return sessionService.deleteSession(sessionId);
}

export function deleteSessionWithStats(sessionId: string) {
  return sessionService.deleteSessionWithStats(sessionId);
}

export function resetSession(sessionId: string) {
  return sessionService.resetSession(sessionId);
}

export function clearSessionMessages(sessionId: string) {
  return sessionService.clearSessionMessages(sessionId);
}

export function appendMessage(
  sessionId: string,
  role: SessionMessageRole,
  content: string,
  options: {
    lastAgentMode?: AgentMode;
    grounding?: SessionMessageGrounding;
    observationMeta?: SessionMessageObservationMeta;
    observationContent?: string;
    thinkingTrace?: SessionThinkingTraceEntry[];
    source?: SessionMessageSource;
    taskType?: SessionMessageTaskType;
    requestId?: string;
    cronJobId?: string;
    cronTitle?: string;
    triggerType?: string;
  } = {},
) {
  return sessionService.appendMessage(sessionId, role, content, options);
}

export function appendContextEntry(
  sessionId: string,
  options: {
    kind: SessionContextEntryKind;
    content: string;
    observationMeta: SessionMessageObservationMeta;
    requestId?: string;
  },
) {
  return sessionService.appendContextEntry(sessionId, options);
}

export function upsertArtifactPaths(
  sessionId: string,
  inputs: readonly SessionArtifactPathInput[],
) {
  return sessionService.upsertArtifactPaths(sessionId, inputs);
}

export function startRequestStream(sessionId: string, requestId: string) {
  return sessionService.startRequestStream(sessionId, requestId);
}

export function appendRequestEvent(
  sessionId: string,
  requestId: string,
  payload: Record<string, unknown>,
) {
  return sessionService.appendRequestEvent(sessionId, requestId, payload);
}

export function compareAndSwapSessionMemoryCheckpoint(
  sessionId: string,
  command: SessionMemoryCheckpointCommit,
) {
  return sessionService.compareAndSwapSessionMemoryCheckpoint(
    sessionId,
    command,
  );
}

export function deleteMessage(sessionId: string, messageId: string) {
  return sessionService.deleteMessage(sessionId, messageId);
}

export function deleteMessageWithStats(sessionId: string, messageId: string) {
  return sessionService.deleteMessageWithStats(sessionId, messageId);
}
