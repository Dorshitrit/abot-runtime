import type { AutomationSessionOrigin } from "../../sessions/automation-session-origin.js";
import type { SessionStore } from "../ports.js";
import type { RuntimeAttachmentStore } from "../attachments/store.js";
import { traceDebug } from "../observability/debug-logger.js";
import { deleteSessionAttachmentsIfSupported } from "../session/session-attachment-deletion.js";
import { createSessionLifecycleStore } from "../session/session-lifecycle-store.js";

/** The internal transcript is attempt-local; persisted automation evidence outlives it. */
export async function withAutomationAgentSession<T>(
  input: {
    /** Backing adapter, before the environment's user-session lifecycle wrapper. */
    sessions: SessionStore;
    attachments: RuntimeAttachmentStore;
    sessionId: string;
    origin: AutomationSessionOrigin;
  },
  execute: (sessions: SessionStore) => Promise<T>,
): Promise<T> {
  const { sessionId } = input;
  // This guard belongs to one attempt, never the environment's user-session
  // lifecycle. Late writes stay blocked without retaining every retired UUID.
  const { store: sessions } = createSessionLifecycleStore(
    input.sessions, undefined, async (id) => {
      // The lifecycle tombstone and mutation queue precede this cleanup. Keep
      // automationOrigin durable until attachment deletion has succeeded.
      await deleteSessionAttachmentsIfSupported(input.attachments, id);
    },
  );
  if (!sessions.createAutomationSession || !sessions.runAsAutomationSession)
    throw new Error("automation_session_owner_unavailable");
  const handle = await sessions.createAutomationSession(sessionId, input.origin);
  try {
    return await sessions.runAsAutomationSession(handle, async () => {
      let executionFailed = false;
      try {
        return await execute(sessions);
      } catch (error) {
        executionFailed = true;
        throw error;
      } finally {
        try {
          await sessions.deleteSessionWithStats(sessionId);
        } catch (error) {
          if (!executionFailed) throw error;
          // Preserve the primary failure while making failed cleanup observable.
          traceDebug("runtime.automations", "agent_session.cleanup_failed", {
            sessionId, ...input.origin,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
  } finally {
    sessions.releaseAutomationSession?.(handle);
  }
}
