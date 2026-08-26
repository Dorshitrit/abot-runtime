import type {
  SessionContextEntry,
  SessionMessageObservationMeta,
  SessionRecord,
} from "../types.js";

export function defaultCreateMessageId(session: SessionRecord): string {
  let maxId = 0;
  for (const message of session.messages) {
    const match = /^msg-(\d+)$/.exec(message.id);
    if (match) {
      maxId = Math.max(maxId, Number(match[1]));
    }
  }
  return `msg-${maxId + 1}`;
}

export function createContextEntryId(session: SessionRecord): string {
  let maxId = 0;
  for (const entry of session.contextEntries ?? []) {
    const match = /^ctx-(\d+)$/.exec(entry.id);
    if (match) {
      maxId = Math.max(maxId, Number(match[1]));
    }
  }
  return `ctx-${maxId + 1}`;
}

export function pruneSupersededContextEntries(
  entries: SessionContextEntry[],
  nextMeta: SessionMessageObservationMeta,
): SessionContextEntry[] {
  if (nextMeta.kind !== "task_result") {
    return entries;
  }
  const nextRole = nextMeta.taskResultRole;
  return entries.filter((entry) => {
    const meta = entry.observationMeta;
    return meta.kind !== "task_result" || meta.taskResultRole !== nextRole;
  });
}

export function assertValidSessionId(sessionId: string): void {
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("sessionId required");
  }
  if (
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("..")
  ) {
    throw new Error("invalid sessionId");
  }
}

export function assertValidRequestId(requestId: string): void {
  if (!requestId || typeof requestId !== "string") {
    throw new Error("requestId required");
  }
}
