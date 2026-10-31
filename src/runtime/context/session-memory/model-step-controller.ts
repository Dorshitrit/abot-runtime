import type { ModelStepCompactionPreparationContext } from "../../model/context-compaction-contracts.js";
import { withModelAbortSignal } from "../../model/scoped-model-abort.js";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type {
  ModelStepContextCompactionController,
  ModelStepCompactionStageOutcome,
} from "../../model/model-step-port.js";
import type { BoundRequestModelInvocationContext, RequestExecutionSeed } from "../../request/contracts.js";
import { replaceSessionMemoryProjection } from "./message-replacement.js";
import { coordinateExecutionHistoryProjection } from "./execution-coordination.js";

export function createSessionMemoryAwareCompactionController(
  request: BoundRequestModelInvocationContext & Pick<RequestExecutionSeed, "sessionId" | "sessionMemory">,
  activeRequestController: ModelStepContextCompactionController,
): ModelStepContextCompactionController {
  const sessionMemory = request.sessionMemory;
  if (!sessionMemory) {
    return activeRequestController;
  }
  const inputProjection = sessionMemory.project();
  return coordinateExecutionHistoryProjection(sessionMemory, Object.freeze({
    project(messages: readonly ChatMessage[]) {
      const currentProjection = sessionMemory.project();
      const projected = replaceSessionMemoryProjection({
        messages,
        current: inputProjection,
        next: currentProjection,
      });
      return activeRequestController.project(projected);
    },
    getStages() {
      const activeStages = activeRequestController.getStages();
      const currentProjection = sessionMemory.project();
      const hasCompactableSessionHistory =
        currentProjection.compactableTurnCount > 0;
      if (!hasCompactableSessionHistory) return activeStages;
      const scopeId = `session:${request.sessionId}:history`;
      return Object.freeze([
        Object.freeze({
          compactionScope: "session_history" as const,
          scopeId,
          async prepare(
            messages: readonly ChatMessage[],
            context?: ModelStepCompactionPreparationContext,
          ): Promise<ModelStepCompactionStageOutcome> {
            const prepared = await sessionMemory.prepare(withModelAbortSignal(request, context?.abortSignal), context?.onProgress);
            return Object.freeze({
              kind: "prepared",
              preparation: Object.freeze({
                messages: replaceSessionMemoryProjection({
                  messages,
                  current: currentProjection,
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
        }),
        ...activeStages,
      ]);
    },
    hasExhaustedVerifiedCompactionSources(messages) {
      return (
        sessionMemory.project().compactableTurnCount === 0 &&
        activeRequestController.hasExhaustedVerifiedCompactionSources?.(messages) === true
      );
    },
  }));
}
