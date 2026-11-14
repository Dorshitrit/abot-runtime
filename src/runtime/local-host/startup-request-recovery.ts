import { randomUUID } from "node:crypto";
import type { SessionRequestRecord } from "../../sessions/types.js";
import type { SessionStore } from "../ports.js";

/** Runs under the new owner's exclusive lease, before accepting any work. */
export async function recoverInterruptedRequests(sessions: SessionStore): Promise<void> {
  for (const session of await sessions.getAllSessions()) {
    for (const request of session.requests ?? []) {
      if (request.status !== "streaming") continue;
      await recoverInterruptedRequest(sessions, session.id, request);
    }
  }
}

async function recoverInterruptedRequest(
  sessions: SessionStore,
  sessionId: string,
  request: SessionRequestRecord,
): Promise<void> {
  if (request.lifecycle) {
    await interruptDurableActivation(sessions, sessionId, request.requestId);
    return;
  }
  const commandEvent = request.events.find(
    (event) => event.payload.requestKind === "command",
  );
  if (!commandEvent) return;
  // A checkpoint may already be committed. Only settle the abandoned stream;
  // neither replay the command nor alter its history/checkpoint side effects.
  await sessions.appendRequestEvent(sessionId, request.requestId, {
    type: "failed",
    name: "command.failed",
    requestKind: "command",
    command: commandEvent.payload.command,
    sessionId,
    error: "request_interrupted",
  });
}

async function interruptDurableActivation(
  sessions: SessionStore,
  sessionId: string,
  requestId: string,
): Promise<void> {
  const store = sessions.requestLifecycle;
  if (!store) return;
  const current = await store.get(sessionId, requestId);
  if (!current?.activation || current.status !== "streaming") return;
  await store.interruptActivation(sessionId, {
    expected: {
      requestId: current.requestId,
      generation: current.generation,
      revision: current.revision,
      ...current.activation,
    },
    commandId: randomUUID(),
    message: {
      content: "The running task was interrupted by a runtime restart.",
    },
  });
}
