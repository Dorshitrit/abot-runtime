import type { SessionThinkingTraceEntry } from "../../sessions/types.js";
import type { RequestSessionStore } from "../request/session-store.js";
import { traceDebug } from "../observability/debug-logger.js";

type CancelledResponseParams = {
  sessionStore: Pick<RequestSessionStore, "getOrCreateSession" | "appendMessage">;
  sessionId: string;
  requestId: string;
  partialAnswer: string;
  thinkingTrace?: SessionThinkingTraceEntry[];
};

/** Called only after opening the request session; the terminal remains cancelled. */
export async function persistCancelledResponse(
  params: CancelledResponseParams,
): Promise<Record<string, unknown>> {
  try {
    const stoppedResponse = await appendCancelledResponse(params);
    if (stoppedResponse === undefined) return {};
    return { stoppedResponse };
  } catch (error: unknown) {
    traceDebug("runtime.request", "cancelled_response.persist_failed", {
      requestId: params.requestId,
      sessionId: params.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { stoppedResponsePersistenceFailed: true };
  }
}

async function appendCancelledResponse(
  params: CancelledResponseParams,
): Promise<string | undefined> {
  const session = await params.sessionStore.getOrCreateSession(params.sessionId);
  const requestMessages = session.messages.filter(
    (message) => message.requestId === params.requestId,
  );
  const hasPersistedUserMessage = requestMessages.some(
    (message) => message.role === "user",
  );
  if (!hasPersistedUserMessage) return undefined;
  const existingResponse = requestMessages.find(
    (message) => message.role === "assistant",
  );
  if (existingResponse) return existingResponse.content;

  const acknowledgement = "I stopped the task at your request.";
  const output = params.partialAnswer.trim()
    ? `${params.partialAnswer}\n\n${acknowledgement}`
    : acknowledgement;
  await params.sessionStore.appendMessage(
    params.sessionId,
    "assistant",
    output,
    {
      requestId: params.requestId,
      source: "request",
      grounding: "conversation",
      thinkingTrace: params.thinkingTrace,
    },
  );
  return output;
}
