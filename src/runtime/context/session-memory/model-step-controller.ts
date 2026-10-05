import type { ChatMessage } from "../../../model-gateway/types.js";
import type {
  ModelStepContextCompactionController,
  ModelStepCompactionStageOutcome,
} from "../../model/model-step-port.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { replaceSessionMemoryProjection } from "./message-replacement.js";

export function createSessionMemoryAwareCompactionController(
  request: RequestExecutionScope,
  activeRequestController: ModelStepContextCompactionController,
): ModelStepContextCompactionController {
  const sessionMemory = request.sessionMemory;
  if (!sessionMemory) {
    return activeRequestController;
  }
  const inputProjection = sessionMemory.project();
  return Object.freeze({
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
          ): Promise<ModelStepCompactionStageOutcome> {
            const prepared = await sessionMemory.prepare(request);
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
  });
}
