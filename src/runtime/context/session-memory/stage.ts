import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelStepCompactionStage } from "../../model/context-compaction-contracts.js";
import { withModelAbortSignal } from "../../model/scoped-model-abort.js";
import type { BoundRequestModelInvocationContext } from "../../request/contracts.js";
import type {
  RequestSessionMemory,
  SessionMemoryRequestProjection,
} from "./contracts.js";
import { replaceSessionMemoryProjection } from "./message-replacement.js";

/** The same prepared history stage is consumed by automatic admission and explicit commands. */
export function createSessionHistoryCompactionStage(
  request: BoundRequestModelInvocationContext,
  sessionId: string,
  memory: RequestSessionMemory,
  current: SessionMemoryRequestProjection = memory.project(),
): ModelStepCompactionStage {
  const scopeId = `session:${sessionId}:history`;
  return Object.freeze({
    compactionScope: "session_history" as const,
    scopeId,
    async prepare(messages: readonly ChatMessage[], context) {
      const prepared = await memory.prepare(
        withModelAbortSignal(request, context?.abortSignal),
        context?.onProgress,
      );
      return Object.freeze({
        kind: "prepared" as const,
        preparation: Object.freeze({
          messages: replaceSessionMemoryProjection({
            messages,
            current,
            next: prepared.projection,
          }),
          commit: prepared.commit,
          scopeId,
          sourceRevision: prepared.checkpoint.sourceRevision,
          coveredSourceCount: prepared.coveredTurnCount,
          hasExhaustedCompactionSources:
            prepared.projection.compactableTurnCount === 0,
        }),
      });
    },
  });
}
