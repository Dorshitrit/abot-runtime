import { createSessionHistoryCompactionStage } from "./stage.js";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type {
  ModelStepContextCompactionController,
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
      return Object.freeze([
        createSessionHistoryCompactionStage(request, request.sessionId, sessionMemory, currentProjection),
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
