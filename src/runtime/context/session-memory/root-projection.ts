import type { ChatMessage } from "../../../model-gateway/types.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
import type { RequestHistoryMessage } from "../request-context-contracts.js";

export type RootSessionMemoryProjection = Readonly<{
  historyMessages: readonly RequestHistoryMessage[];
  priorConversationMessages: readonly ChatMessage[];
  historyRetention?: "compaction_managed";
}>;

export function projectRootSessionMemory(
  request: Pick<RequestExecutionSeed, "historyMessages" | "sessionMemory">,
): RootSessionMemoryProjection {
  if (!request.sessionMemory) {
    return Object.freeze({
      historyMessages: request.historyMessages,
      priorConversationMessages: Object.freeze([]),
    });
  }
  const projection = request.sessionMemory.project();
  return Object.freeze({
    historyMessages: projection.historyMessages,
    priorConversationMessages: projection.priorConversationMessages,
    historyRetention: "compaction_managed" as const,
  });
}
