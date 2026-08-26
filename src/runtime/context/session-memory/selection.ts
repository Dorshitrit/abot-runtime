import type { ChatMessage } from "../../../model-gateway/types.js";
import type { SessionMemoryCheckpoint } from "../../../sessions/memory/contracts.js";
import type { SessionMessage } from "../../../sessions/types.js";
import {
  resolveCoveredTurnCount,
  type SessionMemorySourceSnapshot,
} from "../../../sessions/memory/source.js";
import type { RequestHistoryMessage } from "../request-context-contracts.js";
import {
  SESSION_MEMORY_PROTECTED_TURN_COUNT,
  type SessionMemoryRequestProjection,
} from "./contracts.js";
import { buildSessionMemoryCheckpointMessage } from "./projection.js";

export function selectSessionMemoryProjection(params: {
  sessionId: string;
  source: SessionMemorySourceSnapshot;
  checkpoint?: SessionMemoryCheckpoint;
}): SessionMemoryRequestProjection {
  const coveredTurnCount = resolveCoveredTurnCount(
    params.source,
    params.checkpoint,
  );
  if (coveredTurnCount === undefined) {
    throw new Error("session_memory_checkpoint_coverage_invalid");
  }
  const uncoveredTurns = params.source.turns.slice(coveredTurnCount);
  const compactableTurnCount = Math.max(
    0,
    uncoveredTurns.length - SESSION_MEMORY_PROTECTED_TURN_COUNT,
  );
  const priorConversationMessages: readonly ChatMessage[] = params.checkpoint
    ? Object.freeze([
        buildSessionMemoryCheckpointMessage(
          params.sessionId,
          params.checkpoint,
        ),
      ])
    : Object.freeze([]);
  return Object.freeze({
    priorConversationMessages,
    historyMessages: Object.freeze(
      uncoveredTurns.flatMap(({ userMessages, assistant }) => [
        ...userMessages.map(toRequestHistoryMessage),
        toRequestHistoryMessage(assistant),
      ]),
    ),
    compactableTurnCount,
    checkpointRevision: params.checkpoint?.revision ?? 0,
    sourceRevision: params.source.sourceRevision,
  });
}

function toRequestHistoryMessage(
  message: SessionMessage,
): RequestHistoryMessage {
  return Object.freeze({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    ...(message.requestId ? { requestId: message.requestId } : {}),
  });
}
