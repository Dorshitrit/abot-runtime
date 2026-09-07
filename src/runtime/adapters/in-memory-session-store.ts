import type { AgentMode } from "../../shared/types.js";
import {
  assertValidSessionArtifactPathInputs,
  upsertSessionArtifactPaths,
} from "../../sessions/artifact-paths.js";
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
} from "../../sessions/record/projection.js";
import {
  assertValidRequestId,
  assertValidSessionId,
  createContextEntryId,
  defaultCreateMessageId,
  pruneSupersededContextEntries,
} from "../../sessions/record/rules.js";
import type {
  SessionArtifactPathInput,
  SessionContextEntry,
  SessionContextEntryKind,
  SessionDeleteResult,
  SessionListResult,
  SessionMessageDeleteResult,
  SessionMessageGrounding,
  SessionMessage,
  SessionMessageObservationMeta,
  SessionMessageRole,
  SessionMessageSource,
  SessionMessageTaskType,
  SessionMessagesClearResult,
  SessionRecord,
  SessionRequestRecord,
  SessionRequestReplay,
  SessionSnapshot,
  SessionThinkingTraceEntry,
} from "../../sessions/types.js";
import type {
  SessionMemoryCheckpointCommit,
  SessionMemoryCheckpointCommitResult,
} from "../../sessions/memory/contracts.js";
import { resolveSessionMemoryCheckpointCommit } from "../../sessions/memory/rules.js";
import type { SessionStore } from "../ports.js";

export type InMemorySessionStoreOptions = {
  initialSessions?: SessionRecord[];
  now?: () => Date;
  createMessageId?: (session: SessionRecord) => string;
};

export function createInMemorySessionStore(
  options: InMemorySessionStoreOptions = {},
): SessionStore {
  const store = new InMemorySessionStore(options);
  return {
    getOrCreateSession: store.getOrCreateSession.bind(store),
    getAllSessions: store.getAllSessions.bind(store),
    listSessions: store.listSessions.bind(store),
    getSessionById: store.getSessionById.bind(store),
    getSessionSnapshot: store.getSessionSnapshot.bind(store),
    getRequestReplayById: store.getRequestReplayById.bind(store),
    updateSessionTitle: store.updateSessionTitle.bind(store),
    updateSessionRuntimeMode: store.updateSessionRuntimeMode.bind(store),
    appendMessage: store.appendMessage.bind(store),
    appendContextEntry: store.appendContextEntry.bind(store),
    upsertArtifactPaths: store.upsertArtifactPaths.bind(store),
    startRequestStream: store.startRequestStream.bind(store),
    appendRequestEvent: store.appendRequestEvent.bind(store),
    compareAndSwapSessionMemoryCheckpoint:
      store.compareAndSwapSessionMemoryCheckpoint.bind(store),
    deleteSession: store.deleteSession.bind(store),
    deleteSessionWithStats: store.deleteSessionWithStats.bind(store),
    resetSession: store.resetSession.bind(store),
    clearSessionMessages: store.clearSessionMessages.bind(store),
    deleteMessage: store.deleteMessage.bind(store),
    deleteMessageWithStats: store.deleteMessageWithStats.bind(store),
  };
}

class InMemorySessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  private readonly mutationQueues = new Map<string, Promise<void>>();

  private readonly now: () => Date;

  private readonly createMessageId: (session: SessionRecord) => string;

  constructor(options: InMemorySessionStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createMessageId = options.createMessageId ?? defaultCreateMessageId;
    for (const session of options.initialSessions ?? []) {
      assertValidSessionId(session.id);
      this.sessions.set(session.id, cloneSession(session));
    }
  }

  async getOrCreateSession(sessionId: string): Promise<SessionRecord> {
    assertValidSessionId(sessionId);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return cloneSession(existing);
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
    this.sessions.set(sessionId, cloneSession(session));
    return cloneSession(session);
  }

  async getAllSessions(): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .map(cloneSession)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
    const session = this.sessions.get(sessionId);
    return session ? cloneSession(session) : null;
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
    for (const session of this.sessions.values()) {
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
      const session = this.sessions.get(sessionId);
      if (!session) {
        return null;
      }
      const nextSession = cloneSession(session);
      if (nextSession.title === normalizedTitle) {
        return nextSession;
      }
      nextSession.title = normalizedTitle;
      nextSession.updatedAt = toIso(this.now);
      this.saveSession(nextSession);
      return cloneSession(nextSession);
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
      const session = this.sessions.get(sessionId);
      if (!session) {
        return null;
      }
      const nextSession = cloneSession(session);
      if (normalizedModeId) {
        if (nextSession.runtimeModeId === normalizedModeId) {
          return nextSession;
        }
        nextSession.runtimeModeId = normalizedModeId;
      } else {
        if (!nextSession.runtimeModeId) {
          return nextSession;
        }
        delete nextSession.runtimeModeId;
      }
      nextSession.updatedAt = toIso(this.now);
      this.saveSession(nextSession);
      return cloneSession(nextSession);
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
      schedule?: import("../../sessions/schedule-metadata.js").ScheduleMessageReference;
      cronTitle?: string;
      triggerType?: string;
      attachments?: SessionMessage["attachments"];
    } = {},
  ): Promise<SessionRecord> {
    assertValidSessionId(sessionId);
    return this.runSessionMutation(sessionId, async () => {
      const session = await this.getWritableSession(sessionId);
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
        ...(options.schedule ? { schedule: options.schedule } : {}),
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

      this.saveSession(session);
      return cloneSession(session);
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
      const session = await this.getWritableSession(sessionId);
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

      this.saveSession(session);
      return cloneSession(session);
    });
  }

  async compareAndSwapSessionMemoryCheckpoint(
    sessionId: string,
    command: SessionMemoryCheckpointCommit,
  ): Promise<SessionMemoryCheckpointCommitResult> {
    assertValidSessionId(sessionId);
    return this.runSessionMutation(sessionId, async () => {
      const session = await this.getWritableSession(sessionId);
      const result = resolveSessionMemoryCheckpointCommit(session, command);
      if (!result.committed) {
        return result;
      }
      session.sessionMemoryCheckpoint = result.checkpoint;
      session.updatedAt = toIso(this.now);
      this.saveSession(session);
      return result;
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
      const session = await this.getWritableSession(sessionId);
      const updatedAt = toIso(this.now);
      session.artifactPaths = upsertSessionArtifactPaths(
        session.artifactPaths ?? [],
        inputs,
        updatedAt,
      );
      session.updatedAt = updatedAt;

      this.saveSession(session);
      return cloneSession(session);
    });
  }

  async startRequestStream(
    sessionId: string,
    requestId: string,
  ): Promise<SessionRecord> {
    assertValidSessionId(sessionId);
    assertValidRequestId(requestId);
    return this.runSessionMutation(sessionId, async () => {
      const session = await this.getWritableSession(sessionId);
      const timestamp = toIso(this.now);
      const existing = getSessionRequest(session, requestId);
      if (existing) {
        existing.status = "streaming";
        existing.updatedAt = timestamp;
        existing.events = compactRequestEvents(existing.events);
        session.updatedAt = timestamp;
        this.saveSession(session);
        return cloneSession(session);
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
      this.saveSession(session);
      return cloneSession(session);
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
      const session = await this.getWritableSession(sessionId);
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

      this.saveSession(session);
      return cloneSession(session);
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const result = await this.deleteSessionWithStats(sessionId);
    return result.deleted;
  }

  async deleteSessionWithStats(
    sessionId: string,
  ): Promise<SessionDeleteResult> {
    assertValidSessionId(sessionId);
    const session = this.sessions.get(sessionId);
    const deleted = this.sessions.delete(sessionId);
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

  async clearSessionMessages(
    sessionId: string,
  ): Promise<SessionMessagesClearResult | null> {
    assertValidSessionId(sessionId);
    return this.runSessionMutation(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      if (!session) {
        return null;
      }
      const nextSession = cloneSession(session);
      const deletedMessages = nextSession.messages.length;
      const deletedRequests = nextSession.requests?.length ?? 0;
      const updatedAt = toIso(this.now);
      nextSession.messages = [];
      nextSession.messageCount = 0;
      nextSession.requests = [];
      nextSession.contextEntries = [];
      nextSession.artifactPaths = [];
      delete nextSession.sessionMemoryCheckpoint;
      delete nextSession.runtimeModeId;
      nextSession.updatedAt = updatedAt;
      this.saveSession(nextSession);
      return {
        sessionId,
        cleared: deletedMessages > 0 || deletedRequests > 0,
        deletedMessages,
        deletedRequests,
        updatedAt: toEpochMs(updatedAt),
      };
    });
  }

  async deleteMessage(
    sessionId: string,
    messageId: string,
  ): Promise<SessionRecord | null> {
    await this.deleteMessageWithStats(sessionId, messageId);
    return this.getSessionById(sessionId);
  }

  async deleteMessageWithStats(
    sessionId: string,
    messageId: string,
  ): Promise<SessionMessageDeleteResult | null> {
    assertValidSessionId(sessionId);
    return this.runSessionMutation(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      if (!session) {
        return null;
      }

      const nextSession = cloneSession(session);
      const targetMessage = nextSession.messages.find((message) =>
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

      const nextMessages = nextSession.messages.filter(
        (message) => !isSameMessageId(message.id, messageId),
      );
      if (nextMessages.length === nextSession.messages.length) {
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
        const requests = nextSession.requests ?? [];
        const request = requests.find((item) => item.requestId === requestId);
        if (request) {
          deletedRequestId = requestId;
          deletedRequestEvents = request.events.length;
          nextSession.requests = requests.filter(
            (item) => item.requestId !== requestId,
          );
        }
        nextSession.contextEntries = (nextSession.contextEntries ?? []).filter(
          (entry) => entry.requestId !== requestId,
        );
      }
      nextSession.messages = nextMessages;
      nextSession.messageCount = nextMessages.length;
      delete nextSession.sessionMemoryCheckpoint;
      if (nextMessages.length === 0) {
        delete nextSession.runtimeModeId;
      }
      nextSession.updatedAt = updatedAt;
      this.saveSession(nextSession);
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

  private async getWritableSession(sessionId: string): Promise<SessionRecord> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return cloneSession(existing);
    }
    return this.getOrCreateSession(sessionId);
  }

  private saveSession(session: SessionRecord): void {
    this.sessions.set(session.id, cloneSession(session));
  }

  private async runSessionMutation<T>(
    sessionId: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.mutationQueues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(mutation);
    const queued = current.then(
      () => undefined,
      () => undefined,
    );
    this.mutationQueues.set(sessionId, queued);

    try {
      return await current;
    } finally {
      if (this.mutationQueues.get(sessionId) === queued) {
        this.mutationQueues.delete(sessionId);
      }
    }
  }
}

function cloneSession(session: SessionRecord): SessionRecord {
  return JSON.parse(JSON.stringify(session)) as SessionRecord;
}

function toIso(now: () => Date): string {
  return now().toISOString();
}
