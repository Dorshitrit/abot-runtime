import type { ChatMessage } from "../../../../model-gateway/types.js";
import type { SessionMemorySettledTurn } from "../../../../sessions/memory/source.js";
import { projectExecutionHistoryContent } from "../../../../sessions/memory/execution-observation.js";
import { isExecutionSessionMemoryScope } from "../../../../sessions/memory/checkpoint-scope.js";
import type { SemanticCompactionSourceSlice } from "../../semantic-compaction/chunking.js";
import {
  SESSION_MEMORY_COMPACTION_INSTRUCTIONS,
  EXECUTION_HISTORY_COMPACTION_INSTRUCTIONS,
} from "./prompt.js";

export type SessionMemoryCompactionBatch =
  | Readonly<{
      turns: readonly SessionMemorySettledTurn[];
      scope?: "execution_agent";
    }>
  | Readonly<{
      scope: "execution_agent";
      turnFragment: SemanticCompactionSourceSlice;
    }>;

export function projectSessionMemoryTurn(
  turn: SessionMemorySettledTurn,
  scope?: "execution_agent",
) {
  return {
    userMessages: turn.userMessages.map((message) => ({
      messageId: message.id,
      content: message.content,
    })),
    assistant: {
      messageId: turn.assistant.id,
      content: isExecutionSessionMemoryScope(scope)
        ? projectExecutionHistoryContent(turn.assistant)
        : turn.assistant.content,
    },
  };
}

export function buildSessionMemoryCompactionMessages(
  previousSummary: string | undefined,
  batch: SessionMemoryCompactionBatch,
): ChatMessage[] {
  const evidenceInstructions = isExecutionSessionMemoryScope(batch.scope)
    ? `\n${EXECUTION_HISTORY_COMPACTION_INSTRUCTIONS}`
    : "";
  return [
    Object.freeze({
      role: "system" as const,
      content: SESSION_MEMORY_COMPACTION_INSTRUCTIONS + evidenceInstructions,
    }),
    Object.freeze({
      role: "user" as const,
      content: JSON.stringify({
        kind: "runtime_session_memory_compaction_input_v1",
        authority: "prior_conversation",
        previousCheckpoint: previousSummary ?? null,
        ...("turnFragment" in batch
          ? { settledTurnFragment: batch.turnFragment }
          : { settledTurns: batch.turns.map((turn) =>
              projectSessionMemoryTurn(turn, batch.scope)) }),
        presenceEffect:
          "summarization_input_only_not_current_request_or_action_authority",
      }),
    }),
  ];
}
