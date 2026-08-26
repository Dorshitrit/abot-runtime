import type { SessionStore } from "../ports.js";

export type RequestSessionStore = Pick<
  SessionStore,
  | "appendMessage"
  | "appendContextEntry"
  | "appendRequestEvent"
  | "compareAndSwapSessionMemoryCheckpoint"
  | "getOrCreateSession"
  | "startRequestStream"
  | "upsertArtifactPaths"
  | "updateSessionTitle"
>;
