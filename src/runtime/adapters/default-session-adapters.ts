import {
  appendContextEntry,
  appendMessage,
  appendRequestEvent,
  buildContextBuckets,
  getAllSessions,
  getOrCreateSession,
  startRequestStream,
  upsertArtifactPaths,
  updateSessionRuntimeMode,
  updateSessionTitle,
  compareAndSwapSessionMemoryCheckpoint,
} from "../../sessions/index.js";
import type {
  ConversationContextProvider,
  SessionStore,
} from "../ports.js";

export const defaultRuntimeSessionStore: Pick<
  SessionStore,
  | "appendMessage"
  | "appendContextEntry"
  | "appendRequestEvent"
  | "compareAndSwapSessionMemoryCheckpoint"
  | "getAllSessions"
  | "getOrCreateSession"
  | "startRequestStream"
  | "upsertArtifactPaths"
  | "updateSessionRuntimeMode"
  | "updateSessionTitle"
> = {
  appendMessage,
  appendContextEntry,
  appendRequestEvent,
  compareAndSwapSessionMemoryCheckpoint,
  getAllSessions,
  getOrCreateSession,
  startRequestStream,
  upsertArtifactPaths,
  updateSessionRuntimeMode,
  updateSessionTitle,
};

export const defaultRuntimeConversationContextProvider: Pick<
  ConversationContextProvider,
  "buildContextBuckets"
> = {
  buildContextBuckets,
};
