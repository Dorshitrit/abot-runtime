import { isSparkSession, SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import type { SessionStore } from "../ports.js";
import type { SessionRequestAdmission } from "../request/session-admission.js";
import type { RuntimeAttachmentStore } from "../attachments/store.js";
import { prepareSparkAttachmentCleanup } from "./spark-session-attachments.js";

export type SessionClearBoundary = <T>(sessionId: string, clear: () => Promise<T>) => Promise<T>;

/** Protect the permanent conversation without changing ordinary session clearing. */
export function createSparkSessionClearBoundary(
  sessions: Pick<SessionStore, "getSessionById" | "requestLifecycle">,
  admission: () => SessionRequestAdmission,
  attachments?: RuntimeAttachmentStore,
  runtimeDirectory?: string,
): SessionClearBoundary {
  return async (sessionId, clear) => {
    if (!(await isCompanionClear(sessions, sessionId))) return clear();
    const release = admission().tryReserve(sessionId);
    if (!release) throw new Error("spark_chat_busy");
    try {
      // Recheck after reservation: a parked request is idle but its saved wait remains active.
      if (await hasSavedCompanionApproval(sessions, sessionId)) throw new Error("spark_chat_busy");
      const cleanup = await prepareSparkAttachmentCleanup(attachments, await sessions.getSessionById(sessionId), runtimeDirectory);
      const result = await clear();
      await cleanup();
      return result;
    } finally { release(); }
  };
}

async function isCompanionClear(
  sessions: Pick<SessionStore, "getSessionById">,
  sessionId: string,
): Promise<boolean> {
  if (sessionId !== SPARK_SESSION_ID) return false;
  const session = await sessions.getSessionById(sessionId);
  if (!session) return false;
  return isSparkSession(session);
}

async function hasSavedCompanionApproval(
  sessions: Pick<SessionStore, "requestLifecycle">,
  sessionId: string,
): Promise<boolean> {
  const waiting = await sessions.requestLifecycle?.listWaiting(sessionId);
  return (waiting?.length ?? 0) > 0;
}
