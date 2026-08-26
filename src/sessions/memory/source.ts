import { createHash } from "node:crypto";

import type { SessionMessage, SessionRecord } from "../types.js";
import type {
  SessionMemoryCheckpoint,
  SessionMemoryMessageReference,
} from "./contracts.js";

export type SessionMemorySettledTurn = Readonly<{
  userMessages: readonly SessionMessage[];
  assistant: SessionMessage;
}>;

export type SessionMemorySourceSnapshot = Readonly<{
  sourceRevision: string;
  turns: readonly SessionMemorySettledTurn[];
  messageReferences: readonly SessionMemoryMessageReference[];
}>;

export function snapshotSessionMemorySource(
  session: Pick<SessionRecord, "messages">,
): SessionMemorySourceSnapshot {
  const turns = collectSettledConversationTurns(session.messages);
  const messageReferences = Object.freeze(
    turns.flatMap(turnMessages).map(createMessageReference),
  );
  return Object.freeze({
    sourceRevision: fingerprint(
      messageReferences.map(({ fingerprint: value }) => value).join("\n"),
    ),
    turns,
    messageReferences,
  });
}

export function resolveCoveredTurnCount(
  snapshot: SessionMemorySourceSnapshot,
  checkpoint: SessionMemoryCheckpoint | undefined,
): number | undefined {
  if (!checkpoint) {
    return 0;
  }
  const covered = checkpoint.coveredMessages;
  if (covered.length > snapshot.messageReferences.length) {
    return undefined;
  }
  const isExactPrefix = covered.every((reference, index) => {
    const source = snapshot.messageReferences[index];
    return (
      source?.messageId === reference.messageId &&
      source.fingerprint === reference.fingerprint
    );
  });
  if (!isExactPrefix) {
    return undefined;
  }
  return resolveTurnBoundary(snapshot.turns, covered.length);
}

export function createSessionMemoryMessageReferences(
  turns: readonly SessionMemorySettledTurn[],
): readonly SessionMemoryMessageReference[] {
  return Object.freeze(turns.flatMap(turnMessages).map(createMessageReference));
}

function collectSettledConversationTurns(
  messages: readonly SessionMessage[],
): readonly SessionMemorySettledTurn[] {
  const pendingUsers: SessionMessage[] = [];
  const turns: SessionMemorySettledTurn[] = [];
  for (const message of messages) {
    if (!isConversationMessage(message)) {
      continue;
    }
    if (message.role === "user") {
      pendingUsers.push(message);
      continue;
    }
    const userMessages = takePendingUsers(pendingUsers, message);
    if (userMessages.length === 0) {
      continue;
    }
    turns.push(Object.freeze({ userMessages, assistant: message }));
  }
  return Object.freeze(turns);
}

function isConversationMessage(message: SessionMessage): boolean {
  return (
    message.grounding !== "tool_observation" &&
    message.content.trim().length > 0
  );
}

function takePendingUsers(
  pendingUsers: SessionMessage[],
  assistant: SessionMessage,
): readonly SessionMessage[] {
  const indexes = findPendingUserIndexes(pendingUsers, assistant);
  const selected = indexes.map((index) => pendingUsers[index]!);
  for (const index of [...indexes].reverse()) {
    pendingUsers.splice(index, 1);
  }
  return Object.freeze(selected);
}

function findPendingUserIndexes(
  pendingUsers: readonly SessionMessage[],
  assistant: SessionMessage,
): readonly number[] {
  if (assistant.requestId) {
    const exact = pendingUsers.flatMap((user, index) =>
      user.requestId === assistant.requestId ? [index] : [],
    );
    if (exact.length > 0) {
      return exact;
    }
    const fallback = findLastIndex(pendingUsers, (user) => !user.requestId);
    return fallback >= 0 ? Object.freeze([fallback]) : Object.freeze([]);
  }
  const latest = pendingUsers.length - 1;
  return latest >= 0 ? Object.freeze([latest]) : Object.freeze([]);
}

function findLastIndex<T>(
  entries: readonly T[],
  predicate: (entry: T) => boolean,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (predicate(entries[index]!)) {
      return index;
    }
  }
  return -1;
}

function createMessageReference(
  message: SessionMessage,
): SessionMemoryMessageReference {
  return Object.freeze({
    messageId: message.id,
    fingerprint: fingerprint(
      JSON.stringify({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        requestId: message.requestId ?? null,
      }),
    ),
  });
}

function turnMessages(
  turn: SessionMemorySettledTurn,
): readonly SessionMessage[] {
  return [...turn.userMessages, turn.assistant];
}

function resolveTurnBoundary(
  turns: readonly SessionMemorySettledTurn[],
  coveredMessageCount: number,
): number | undefined {
  if (coveredMessageCount === 0) {
    return 0;
  }
  let messageCount = 0;
  for (let index = 0; index < turns.length; index += 1) {
    messageCount += turnMessages(turns[index]!).length;
    if (messageCount === coveredMessageCount) {
      return index + 1;
    }
    if (messageCount > coveredMessageCount) {
      return undefined;
    }
  }
  return undefined;
}

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
