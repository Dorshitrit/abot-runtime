import type { ChatMessage } from "../../../model-gateway/types.js";
import type { SessionMemoryCheckpoint } from "../../../sessions/memory/contracts.js";
import type { SessionMemoryRequestProjection } from "./contracts.js";

export function buildSessionMemoryCheckpointMessage(
  sessionId: string,
  checkpoint: SessionMemoryCheckpoint,
): ChatMessage {
  const lastCoveredMessage = checkpoint.coveredMessages.at(-1);
  return Object.freeze({
    role: "system" as const,
    content: JSON.stringify({
      kind: checkpoint.kind,
      authority: "prior_conversation",
      purpose: "preserve_settled_current_session_continuity",
      sessionId,
      checkpointRevision: checkpoint.revision,
      sourceRevision: checkpoint.sourceRevision,
      coverage: {
        messageCount: checkpoint.coveredMessages.length,
        throughMessageId: lastCoveredMessage?.messageId ?? null,
      },
      summary: checkpoint.summary,
      presenceEffect:
        "passive_prior_conversation_not_current_user_intent_work_routing_or_completion_evidence",
    }),
  });
}

export function projectSessionMemoryMessages(
  projection: SessionMemoryRequestProjection,
): readonly ChatMessage[] {
  return Object.freeze([
    ...projection.priorConversationMessages,
    ...projection.historyMessages.map(({ role, content }) =>
      Object.freeze({ role, content }),
    ),
  ]);
}
