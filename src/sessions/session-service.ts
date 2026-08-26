import { getDefaultSessionsDir } from "../runtime/config/layout.js";
import {
  assertValidSessionArtifactPathInputs,
  upsertSessionArtifactPaths,
} from "./artifact-paths.js";
import {
  clientVisibleMessages,
  compactRequestEvents,
  filterMessagesAfter,
  getRequestFinalState,
  getSessionRequest,
  isSameMessageId,
  normalizeAfterSeq,
  normalizeCursor,
  normalizeLimit,
  normalizeSessionTitle,
  toClientReplayEvent,
  toEpochMs,
  toSessionListItem,
  toSnapshotMessage,
  toSnapshotRequest,
} from "./record/projection.js";
import {
  assertValidRequestId,
  assertValidSessionId,
  createContextEntryId,
  defaultCreateMessageId,
  pruneSupersededContextEntries,
} from "./record/rules.js";
import {
  deleteSessionFile,
  ensureSessionsDir,
  loadAllSessionFiles,
  loadSessionFile,
  saveSessionFile,
} from "./session-store.js";
import type {
  SessionContextEntry,
  SessionContextEntryKind,
  SessionArtifactPathInput,
  SessionMessageGrounding,
  SessionMessage,
  SessionMessageDeleteResult,
  SessionMessageObservationMeta,
  SessionMessageRole,
  SessionMessageSource,
  SessionMessageTaskType,
  SessionMessagesClearResult,
  SessionDeleteResult,
  SessionListResult,
  SessionRequestReplay,
  SessionRequestRecord,
  SessionRecord,
  SessionSnapshot,
  SessionThinkingTraceEntry,
} from "./types.js";
import type {
  SessionMemoryCheckpointCommit,
  SessionMemoryCheckpointCommitResult,
} from "./memory/contracts.js";
import { resolveSessionMemoryCheckpointCommit } from "./memory/rules.js";
import type { AgentMode } from "../shared/types.js";

type SessionServiceOptions = {
  sessionsDir?: string;
  now?: () => Date;
  createMessageId?: (session: SessionRecord) => string;
};

function toIso(now: () => Date): string {
  return now().toISOString();
}

export class SessionService {
  private readonly sessionsDir: string;

  private readonly now: () => Date;

  private readonly createMessageId: (session: SessionRecord) => string;

  private readonly sessionMutationQueues = new Map<string, Promise<void>>();

  constructor(options: SessionServiceOptions = {}) {
    this.sessionsDir =
      options.sessionsDir || getDefaultSessionsDir(process.cwd());
    this.now = options.now || (() => new Date());
    this.createMessageId = options.createMessageId || defaultCreateMessageId;
  }

  async getOrCreateSession(sessionId: string): Promise<SessionRecord> {
    assertValidSessionId(sessionId);
    await ensureSessionsDir(this.sessionsDir);
    const existing = await loadSessionFile(this.sessionsDir, sessionId);
    if (existing) {
      return existing;
    }

    const timestamp = toIso(this.now);
    const session: SessionRecord = {
      id: sessionId,
      title: sessionId,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAgentMode: "reasoning",
      messageCount: 0,
      messages: [],
    };
    await saveSessionFile(this.sessionsDir, session);
    return session;
  }

  async getAllSessions(): Promise<SessionRecord[]> {
    const sessions = await loadAllSessionFiles(this.sessionsDir);
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listSessions(
    params: {
      limit?: number;
      cursor?: string | null;
    } = {},
  ): Promise<SessionListResult> {
    const limit = normalizeLimit(params.limit);
    const offset = normalizeCursor(params.cursor);
    const sessions = await this.getAllSessions();
    const selected = sessions.slice(offset, offset + limit);
    const nextOffset = offset + selected.length;
    return {
      sessions: selected.map(toSessionListItem),
      nextCursor: nextOffset < sessions.length ? String(nextOffset) : null,
    };
  }

  async getSessionById(sessionId: string): Promise<SessionRecord | null> {
    assertValidSessionId(sessionId);
    await ensureSessionsDir(this.sessionsDir);
    return loadSessionFile(this.sessionsDir, sessionId);
  }

  async getSessionSnapshot(
    sessionId: string,
    options: {
      afterMessageId?: string | number | null;
      includeRequests?: boolean;
    } = {},
  ): Promise<SessionSnapshot | null> {
    const session = await this.getSessionById(sessionId);
    if (!session) {
      return null;
    }
    return {
      sessionId,
      title: session.title,
      messages: filterMessagesAfter(
        clientVisibleMessages(session.messages),
        options.afterMessageId,
      ).map((message) =>
        toSnapshotMessage(sessionId, message, session.requests ?? []),
      ),
      requests:
        options.includeRequests === false
          ? []
          : (session.requests ?? []).map(toSnapshotRequest),
      nextCursor: null,
    };
  }

  async getRequestReplayById(
    requestId: string,
    afterSeq = 0,
  ): Promise<SessionRequestReplay | null> {
    assertValidRequestId(requestId);
    const normalizedAfterSeq = normalizeAfterSeq(afterSeq);
    const sessions = await loadAllSessionFiles(this.sessionsDir);
    for (const session of sessions) {
      const request = getSessionRequest(session, requestId);
      if (!request) {
        continue;
      }

      return {
        requestId,
        sessionId: request.sessionId,
        events: request.events
          .filter((event) => event.seqNo > normalizedAfterSeq)
          .map(toClientReplayEvent),
        finalState: getRequestFinalState(request),
      };
    }
    return null;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const result = await this.deleteSessionWithStats(sessionId);
    return result.deleted;
  }

  async deleteSessionWithStats(
    sessionId: string,
  ): Promise<SessionDeleteResult> {
    assertValidSessionId(sessionId);
    await ensureSessionsDir(this.sessionsDir);
    const session = await loadSessionFile(this.sessionsDir, sessionId);
    const deleted = await deleteSessionFile(this.sessionsDir, sessionId);
    return {
      sessionId,
      deleted,
      deletedMessages: deleted ? (session?.messages.length ?? 0) : 0,
      deletedRequests: deleted ? (session?.requests?.length ?? 0) : 0,
    };
  }

  async resetSession(sessionId: string): Promise<SessionRecord | null> {
    const result = await this.clearSessionMessages(sessionId);
    if (!result) {
      return null;
    }
    return this.getSessionById(sessionId);
  }

  async updateSessionTitle(
    sessionId: string,
    title: string,
  ): Promise<SessionRecord | null> {
    assertValidSessionId(sessionId);
    const normalizedTitle = normalizeSessionTitle(title);
    if (!normalizedTitle) {
      return this.getSessionById(sessionId);
    }
    return this.runSessionMutation(sessionId, async () => {
      const session = await this.getSessionById(sessionId);
      if (!session) {
        return null;
      }
      if (session.title === normalizedTitle) {
        return session;
      }
      session.title = normalizedTitle;
      session.updatedAt = toIso(this.now);
      await saveSessionFile(this.sessionsDir, session);
      return session;
    });
  }

  async updateSessionRuntimeMode(
    sessionId: string,
    runtimeModeId: string | null,
  ): Promise<SessionRecord | null> {
    assertValidSessionId(sessionId);
    const normalizedModeId =
      typeof runtimeModeId === "string" ? runtimeModeId.trim() : "";
    return this.runSessionMutation(sessionId, async () => {
      const session = await this.getOrCreateSession(sessionId);
      if (normalizedModeId) {
        if (session.runtimeModeId === normalizedModeId) {
          return session;
        }
        session.runtimeModeId = normalizedModeId;
      } else {
        if (!session.runtimeModeId) {
          return session;
        }
        delete session.runtimeModeId;
      }
      session.updatedAt = toIso(this.now);
      await saveSessionFile(this.sessionsDir, session);
      return session;
    });
  }

  async clearSessionMessages(
    sessionId: string,
  ): Promise<SessionMessagesClearResult | null> {
    assertValidSessionId(sessionId);
    return this.runSessionMutation(sessionId, async () => {
      const session = await this.getSessionById(sessionId);
      if (!session) {
        return null;
      }
      const deletedMessages = session.messages.length;
      const deletedRequests = session.requests?.length ?? 0;
      const updatedAt = toIso(this.now);
      session.messages = [];
      session.messageCount = 0;
      session.requests = [];
      session.contextEntries = [];
      session.artifactPaths = [];
      delete session.sessionMemoryCheckpoint;
      delete session.runtimeModeId;
      session.updatedAt = updatedAt;
      await saveSessionFile(this.sessionsDir, session);
      return {
        sessionId,
        cleared: deletedMessages > 0 || deletedRequests > 0,
        deletedMessages,
        deletedRequests,
        updatedAt: toEpochMs(updatedAt),
      };
    });
  }

  async appendMessage(
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
      attachments?: SessionMessage["attachments"];
    } = {},
  ): Promise<SessionRecord> {
    assertValidSessionId(sessionId);
    return this.runSessionMutation(sessionId, async () => {
      const session = await this.getOrCreateSession(sessionId);
      const createdAt = toIso(this.now);

      session.messages.push({
        id: this.createMessageId(session),
        role,
        content,
        createdAt,
        source: options.source,
        taskType: options.taskType,
        requestId: options.requestId,
        cronJobId: options.cronJobId,
        cronTitle: options.cronTitle,
        triggerType: options.triggerType,
        attachments: options.attachments,
        grounding: options.grounding,
        observationMeta: options.observationMeta,
        observationContent: options.observationContent,
        thinkingTrace: options.thinkingTrace,
      });
      session.messageCount = session.messages.length;
      session.updatedAt = createdAt;
      if (options.lastAgentMode) {
        session.lastAgentMode = options.lastAgentMode;
      }

      await saveSessionFile(this.sessionsDir, session);
      return session;
    });
  }

  async compareAndSwapSessionMemoryCheckpoint(
    sessionId: string,
    command: SessionMemoryCheckpointCommit,
  ): Promise<SessionMemoryCheckpointCommitResult> {
    assertValidSessionId(sessionId);
    return this.runSessionMutation(sessionId, async () => {
      const session = await this.getOrCreateSession(sessionId);
      const result = resolveSessionMemoryCheckpointCommit(session, command);
      if (!result.committed) {
        return result;
      }
      session.sessionMemoryCheckpoint = result.checkpoint;
      session.updatedAt = toIso(this.now);
      await saveSessionFile(this.sessionsDir, session);
      return result;
    });
  }

  async appendContextEntry(
    sessionId: string,
    options: {
      kind: SessionContextEntryKind;
      content: string;
      observationMeta: SessionMessageObservationMeta;
      requestId?: string;
    },
  ): Promise<SessionRecord> {
    assertValidSessionId(sessionId);
    return this.runSessionMutation(sessionId, async () => {
      const session = await this.getOrCreateSession(sessionId);
      const createdAt = toIso(this.now);
      const nextEntry = {
        id: createContextEntryId(session),
        kind: options.kind,
        content: options.content,
        createdAt,
        requestId: options.requestId,
        observationMeta: options.observationMeta,
      };

      session.contextEntries = [
        ...pruneSupersededContextEntries(
          session.contextEntries ?? [],
          nextEntry.observationMeta,
        ),
        nextEntry,
      ];
      session.updatedAt = createdAt;

      await saveSessionFile(this.sessionsDir, session);
      return session;
    });
  }

  async upsertArtifactPaths(
    sessionId: string,
    inputs: readonly SessionArtifactPathInput[],
  ): Promise<SessionRecord> {
    assertValidSessionId(sessionId);
    assertValidSessionArtifactPathInputs(inputs);
    if (inputs.length === 0) {
      return this.getOrCreateSession(sessionId);
    }
    return this.runSessionMutation(sessionId, async () => {
      const session = await this.getOrCreateSession(sessionId);
      const updatedAt = toIso(this.now);
      session.artifactPaths = upsertSessionArtifactPaths(
        session.artifactPaths ?? [],
        inputs,
        updatedAt,
      );
      session.updatedAt = updatedAt;

      await saveSessionFile(this.sessionsDir, session);
      return session;
    });
  }

  async startRequestStream(
    sessionId: string,
    requestId: string,
  ): Promise<SessionRecord> {
    assertValidSessionId(sessionId);
    assertValidRequestId(requestId);
    return this.runSessionMutation(sessionId, async () => {
      const session = await this.getOrCreateSession(sessionId);
      const timestamp = toIso(this.now);
      const existing = getSessionRequest(session, requestId);
      if (existing) {
        existing.status = "streaming";
        existing.updatedAt = timestamp;
        existing.events = compactRequestEvents(existing.events);
        session.updatedAt = timestamp;
        await saveSessionFile(this.sessionsDir, session);
        return session;
      }

      const request: SessionRequestRecord = {
        requestId,
        sessionId,
        status: "streaming",
        createdAt: timestamp,
        updatedAt: timestamp,
        lastSeqNo: 0,
        events: [],
      };
      session.requests = [...(session.requests ?? []), request];
      session.updatedAt = timestamp;
      await saveSessionFile(this.sessionsDir, session);
      return session;
    });
  }

  async appendRequestEvent(
    sessionId: string,
    requestId: string,
    payload: Record<string, unknown>,
  ): Promise<SessionRecord> {
    assertValidSessionId(sessionId);
    assertValidRequestId(requestId);
    return this.runSessionMutation(sessionId, async () => {
      const session = await this.getOrCreateSession(sessionId);
      const timestamp = toIso(this.now);
      let request = getSessionRequest(session, requestId);
      if (!request) {
        request = {
          requestId,
          sessionId,
          status: "streaming",
          createdAt: timestamp,
          updatedAt: timestamp,
          lastSeqNo: 0,
          events: [],
        };
        session.requests = [...(session.requests ?? []), request];
      }

      const type = typeof payload.type === "string" ? payload.type : "event";
      const seqNo = request.lastSeqNo + 1;
      const eventPayload = {
        ...payload,
        type,
        requestId,
        seqNo,
        timestamp,
      };

      request.lastSeqNo = seqNo;
      request.updatedAt = timestamp;
      const event = {
        seqNo,
        type,
        requestId,
        timestamp,
        payload: eventPayload,
      };
      request.events.push(event);
      request.events = compactRequestEvents(request.events);
      if (type === "completed") {
        request.status = "completed";
      } else if (type === "failed") {
        request.status = "failed";
      } else if (
        request.status !== "failed" &&
        request.status !== "completed"
      ) {
        request.status = "streaming";
      }
      session.updatedAt = timestamp;

      await saveSessionFile(this.sessionsDir, session);
      return session;
    });
  }

  async deleteMessage(
    sessionId: string,
    messageId: string,
  ): Promise<SessionRecord | null> {
    const result = await this.deleteMessageWithStats(sessionId, messageId);
    if (!result?.deleted) {
      return this.getSessionById(sessionId);
    }
    return this.getSessionById(sessionId);
  }

  async deleteMessageWithStats(
    sessionId: string,
    messageId: string,
  ): Promise<SessionMessageDeleteResult | null> {
    assertValidSessionId(sessionId);
    return this.runSessionMutation(sessionId, async () => {
      const session = await this.getSessionById(sessionId);
      if (!session) {
        return null;
      }

      const targetMessage = session.messages.find((message) =>
        isSameMessageId(message.id, messageId),
      );
      const updatedAt = toIso(this.now);
      if (!targetMessage) {
        return {
          sessionId,
          messageId,
          deleted: false,
          updatedAt: toEpochMs(updatedAt),
        };
      }

      const nextMessages = session.messages.filter(
        (message) => !isSameMessageId(message.id, messageId),
      );
      if (nextMessages.length === session.messages.length) {
        return {
          sessionId,
          messageId,
          deleted: false,
          updatedAt: toEpochMs(updatedAt),
        };
      }

      const requestId = targetMessage.requestId;
      let deletedRequestId: string | undefined;
      let deletedRequestEvents: number | undefined;
      if (requestId) {
        const requests = session.requests ?? [];
        const request = requests.find((item) => item.requestId === requestId);
        if (request) {
          deletedRequestId = requestId;
          deletedRequestEvents = request.events.length;
          session.requests = requests.filter(
            (item) => item.requestId !== requestId,
          );
        }
        session.contextEntries = (session.contextEntries ?? []).filter(
          (entry) => entry.requestId !== requestId,
        );
      }
      session.messages = nextMessages;
      session.messageCount = nextMessages.length;
      delete session.sessionMemoryCheckpoint;
      if (nextMessages.length === 0) {
        delete session.runtimeModeId;
      }
      session.updatedAt = updatedAt;
      await saveSessionFile(this.sessionsDir, session);
      return {
        sessionId,
        messageId,
        deleted: true,
        updatedAt: toEpochMs(updatedAt),
        ...(deletedRequestId ? { deletedRequestId } : {}),
        ...(typeof deletedRequestEvents === "number"
          ? { deletedRequestEvents }
          : {}),
      };
    });
  }

  private async runSessionMutation<T>(
    sessionId: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.sessionMutationQueues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(mutation);
    const queued = current.then(
      () => undefined,
      () => undefined,
    );
    this.sessionMutationQueues.set(sessionId, queued);

    try {
      return await current;
    } finally {
      if (this.sessionMutationQueues.get(sessionId) === queued) {
        this.sessionMutationQueues.delete(sessionId);
      }
    }
  }
}
