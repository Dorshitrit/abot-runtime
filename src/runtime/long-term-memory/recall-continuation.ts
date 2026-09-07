import type { ChatMessage } from "../../model-gateway/types.js";
import type { RecallProjection } from "./recall-context.js";

export type MemoryRecallContinuation = Readonly<{
  invocationAttempt: number;
  completedChildCount: number;
  messages: readonly ChatMessage[];
}>;

/** Present only the settled, bounded records selected by the memory owner. */
export function projectMemoryRecallContinuations(
  message: ChatMessage | undefined,
): readonly MemoryRecallContinuation[] {
  if (!message) return Object.freeze([]);
  const reference = JSON.parse(message.content) as {
    recalls: readonly RecallProjection[];
    [key: string]: unknown;
  };
  return Object.freeze(
    reference.recalls.map((recall) =>
      Object.freeze({
        invocationAttempt: recall.invocationAttempt,
        completedChildCount: recall.completedChildCount,
        messages: Object.freeze([
          Object.freeze({
            role: "assistant" as const,
            content: "",
            toolCalls: Object.freeze([
              Object.freeze({
                callId: recall.recallId,
                name: "recall_memory",
                arguments: JSON.stringify({
                  action: "recall_memory",
                  query: recall.query,
                }),
              }),
            ]),
          }),
          Object.freeze({
            role: "tool" as const,
            toolCallId: recall.recallId,
            toolName: "recall_memory",
            content: JSON.stringify({
              ...reference,
              omittedRecordCount: recall.omittedRecordCount,
              recalls: [recall],
            }),
          }),
        ]),
      }),
    ),
  );
}
