import type { SessionRecord, SessionRequestRecord } from "../../sessions/types.js";
import { getRequestFinalState } from "../../sessions/record/projection.js";
import { traceDebug } from "../observability/debug-logger.js";
import type { EventSink } from "../ports.js";
import type { RequestSessionStore } from "../request/session-store.js";

export function createRequestSessionTitleUpdater(params: {
  shouldGenerateTitle: boolean;
  sessionId: string;
  requestId: string;
  sessionStore: Pick<RequestSessionStore, "updateSessionTitle">;
  events: EventSink;
  abortSignal: AbortSignal;
}): (title: string) => Promise<void> {
  return async (title: string) => {
    if (!params.shouldGenerateTitle || params.abortSignal.aborted) {
      return;
    }

    let updatedSession: SessionRecord | null;
    try {
      updatedSession = await params.sessionStore.updateSessionTitle(
        params.sessionId,
        title,
      );
    } catch (error: unknown) {
      traceDebug("runtime.session_title", "update.failed", {
        requestId: params.requestId,
        sessionId: params.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (
      params.abortSignal.aborted ||
      !updatedSession ||
      updatedSession.title !== title
    ) {
      return;
    }

    params.events.event("session.title.updated", {
      sessionId: params.sessionId,
      title,
    });
    traceDebug("runtime.session_title", "updated", {
      requestId: params.requestId,
      sessionId: params.sessionId,
      titleLength: title.length,
    });
  };
}

export function shouldGenerateSessionTitle(session: SessionRecord): boolean {
  const hasPlaceholderTitle =
    !session.title.trim() || session.title === session.id;
  if (!hasPlaceholderTitle) return false;
  if (session.messages.length === 0) return true;
  return hasOnlyCancelledRequestMessages(session);
}

function hasOnlyCancelledRequestMessages(session: SessionRecord): boolean {
  const cancelledIds = new Set(
    (session.requests ?? [])
      .filter(isUserCancelledRequest)
      .map(({ requestId }) => requestId),
  );
  return session.messages.every(
    (message) =>
      cancelledIds.has(message.requestId ?? ""),
  );
}

function isUserCancelledRequest(request: SessionRequestRecord): boolean {
  if (request.status !== "failed") return false;
  const terminal = getRequestFinalState(request);
  return (
    terminal?.status === "failed" && terminal.error === "request_cancelled"
  );
}
