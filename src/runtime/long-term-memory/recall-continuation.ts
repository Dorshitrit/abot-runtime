import type { ChatMessage } from "../../model-gateway/types.js";
import type { RecallProjection } from "./recall-context.js";

export type MemoryRecallContinuation = Readonly<{
  invocationAttempt: number;
  completedChildCount: number;
  messages: readonly ChatMessage[];
}>;

type RecallReference = Readonly<{
  recalls: readonly RecallProjection[];
  omittedRecallCount: number;
  omittedRecordCount: number;
  [key: string]: unknown;
}>;

/** Present only the settled, bounded records selected by the memory owner. */
export function projectMemoryRecallContinuations(
  message: ChatMessage | undefined,
): readonly MemoryRecallContinuation[] {
  if (!message) return Object.freeze([]);
  const reference = JSON.parse(message.content) as RecallReference;
  return Object.freeze(reference.recalls.map((recall) =>
    buildRecallContinuation(recall, JSON.stringify({
      ...reference,
      omittedRecordCount: recall.omittedRecordCount,
      recalls: [recall],
    })),
  ));
}

/** Final authoring sees the aggregate omissions and the full result of each included lookup. */
export function projectResponseMemoryRecall(message: ChatMessage): Readonly<{
  continuations: readonly MemoryRecallContinuation[];
  omissionNotice?: string;
}> {
  const reference = JSON.parse(message.content) as RecallReference;
  if (reference.recalls.length === 0) {
    return {
      continuations: [],
      omissionNotice: `Stored memory lookup results were omitted. ${describeRecallOmissions(reference)}`,
    };
  }
  return { continuations: Object.freeze(reference.recalls.map((recall) => {
    // The linked action already carries the original query.
    const { query: _query, ...result } = recall;
    return buildRecallContinuation(recall, JSON.stringify({ ...reference, recalls: [result] }));
  })) };
}

/** When no action fits the projection, only bounded numeric counts may enter instructions. */
export function describeRecallOmissions({ omittedRecallCount, omittedRecordCount }: Pick<
  RecallReference, "omittedRecallCount" | "omittedRecordCount"
>): string {
  if (![omittedRecallCount, omittedRecordCount].every(count => Number.isSafeInteger(count) && count >= 0)) {
    throw new Error("memory_recall_omission_counts_invalid");
  }
  return `Omitted lookup results: ${omittedRecallCount}. Omitted stored facts: ${omittedRecordCount}.`;
}

function buildRecallContinuation(recall: RecallProjection, resultContent: string): MemoryRecallContinuation {
  return Object.freeze({
    invocationAttempt: recall.invocationAttempt,
    completedChildCount: recall.completedChildCount,
    messages: buildMemoryRecallMessagePair(recall, resultContent),
  });
}

/** Keep the original action and tool linkage when a consumer bounds its result differently. */
export function buildMemoryRecallMessagePair(
  recall: Pick<RecallProjection, "recallId" | "query">,
  resultContent: string,
) {
  return Object.freeze([
    Object.freeze({
      role: "assistant" as const,
      content: "" as const,
      toolCalls: Object.freeze([Object.freeze({
        callId: recall.recallId,
        name: "recall_memory",
        arguments: JSON.stringify({ action: "recall_memory", query: recall.query }),
      })]),
    }),
    Object.freeze({
      role: "tool" as const,
      toolCallId: recall.recallId,
      toolName: "recall_memory",
      content: resultContent,
    }),
  ] as const);
}
