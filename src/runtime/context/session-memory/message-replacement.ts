import type { ChatMessage } from "../../../model-gateway/types.js";
import type { SessionMemoryRequestProjection } from "./contracts.js";
import { projectSessionMemoryMessages } from "./projection.js";

export function replaceSessionMemoryProjection(params: {
  messages: readonly ChatMessage[];
  current: SessionMemoryRequestProjection;
  next: SessionMemoryRequestProjection;
}): ChatMessage[] {
  const currentMessages = projectSessionMemoryMessages(params.current);
  const nextMessages = projectSessionMemoryMessages(params.next);
  if (sameMessageSequence(currentMessages, nextMessages)) {
    return [...params.messages];
  }
  const matchIndexes = findSequenceIndexes(params.messages, currentMessages);
  if (matchIndexes.length !== 1) {
    throw new Error(
      matchIndexes.length === 0
        ? "session_memory_projection_not_found"
        : "session_memory_projection_ambiguous",
    );
  }
  const start = matchIndexes[0]!;
  return [
    ...params.messages.slice(0, start),
    ...nextMessages,
    ...params.messages.slice(start + currentMessages.length),
  ];
}

function findSequenceIndexes(
  messages: readonly ChatMessage[],
  sequence: readonly ChatMessage[],
): number[] {
  if (sequence.length === 0) {
    return [];
  }
  const matches: number[] = [];
  for (let index = 0; index <= messages.length - sequence.length; index += 1) {
    if (
      sequence.every((candidate, offset) =>
        sameMessage(messages[index + offset]!, candidate),
      )
    ) {
      matches.push(index);
    }
  }
  return matches;
}

function sameMessageSequence(
  left: readonly ChatMessage[],
  right: readonly ChatMessage[],
): boolean {
  return (
    left.length === right.length &&
    left.every((message, index) => sameMessage(message, right[index]!))
  );
}

function sameMessage(left: ChatMessage, right: ChatMessage): boolean {
  return left.role === right.role && left.content === right.content;
}
