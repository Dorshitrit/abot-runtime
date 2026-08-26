import { SessionService } from "../../sessions/session-service.js";
import type { SessionRecord } from "../../sessions/types.js";
import type { SessionStore } from "../ports.js";

export type FileSessionStoreOptions = {
  sessionsDir?: string;
  now?: () => Date;
  createMessageId?: (session: SessionRecord) => string;
};

export function createFileSessionStore(
  options: FileSessionStoreOptions = {},
): SessionStore {
  const service = new SessionService(options);
  return {
    getOrCreateSession: service.getOrCreateSession.bind(service),
    getAllSessions: service.getAllSessions.bind(service),
    listSessions: service.listSessions.bind(service),
    getSessionById: service.getSessionById.bind(service),
    getSessionSnapshot: service.getSessionSnapshot.bind(service),
    getRequestReplayById: service.getRequestReplayById.bind(service),
    updateSessionTitle: service.updateSessionTitle.bind(service),
    updateSessionRuntimeMode: service.updateSessionRuntimeMode.bind(service),
    appendMessage: service.appendMessage.bind(service),
    appendContextEntry: service.appendContextEntry.bind(service),
    upsertArtifactPaths: service.upsertArtifactPaths.bind(service),
    startRequestStream: service.startRequestStream.bind(service),
    appendRequestEvent: service.appendRequestEvent.bind(service),
    compareAndSwapSessionMemoryCheckpoint:
      service.compareAndSwapSessionMemoryCheckpoint.bind(service),
    deleteSession: service.deleteSession.bind(service),
    deleteSessionWithStats: service.deleteSessionWithStats.bind(service),
    resetSession: service.resetSession.bind(service),
    clearSessionMessages: service.clearSessionMessages.bind(service),
    deleteMessage: service.deleteMessage.bind(service),
    deleteMessageWithStats: service.deleteMessageWithStats.bind(service),
  };
}
