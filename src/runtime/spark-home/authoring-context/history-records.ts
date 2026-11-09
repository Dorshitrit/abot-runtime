import { SPARK_SESSION_ID } from "../../../sessions/spark-session.js";
import { AUTHORING_CONTEXT_LIMITS as limits, type AuthoringContextDependencies } from "./contracts.js";
import { contextFailure, requireSource } from "./projection.js";

/** The same bounded conversations serve independent planning and HTML projections. */
export async function captureHistoryRecords(sessions: AuthoringContextDependencies["sessions"]) {
  return requireSource("history", async () => {
    const recent = await sessions.listSessions({ limit: limits.ordinarySessions + 1 });
    const ordinary = recent.sessions.filter(session => session.id !== SPARK_SESSION_ID && session.kind !== "spark")
      .slice(0, limits.ordinarySessions);
    const ids = [SPARK_SESSION_ID, ...ordinary.map(session => session.id)];
    const loaded = await Promise.all(ids.map(sessionId => sessions.getSessionSnapshot(sessionId, {
      includeRequests: false, page: { limit: limits.messagesPerSession * 2 },
    })));
    const snapshots = loaded.flatMap((snapshot, index) => {
      if (!snapshot && ids[index] === SPARK_SESSION_ID) return [];
      if (!snapshot) contextFailure("history_unavailable", "A selected conversation is unavailable; SPARK HOME context was not prepared.");
      if (snapshot.sessionId !== ids[index]) contextFailure("history_binding_invalid", "Conversation identity changed while preparing SPARK HOME context.");
      return [snapshot];
    });
    return { snapshots, scannedCount: recent.sessions.length, moreSessionsNotLoaded: recent.nextCursor !== null };
  });
}

export type CapturedHistoryRecords = Awaited<ReturnType<typeof captureHistoryRecords>>;
