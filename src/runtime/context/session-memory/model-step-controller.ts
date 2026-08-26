import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelStepContextCompactionController } from "../../model/model-step-port.js";
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
    get compactionScope() {
      return sessionMemory.project().compactableTurnCount > 0
        ? ("session_history" as const)
        : activeRequestController.compactionScope;
    },
    project(messages: readonly ChatMessage[]) {
      const currentProjection = sessionMemory.project();
      const projected = replaceSessionMemoryProjection({
        messages,
        current: inputProjection,
        next: currentProjection,
      });
      return activeRequestController.project(projected);
    },
    async prepare(messages: readonly ChatMessage[]) {
      const currentProjection = sessionMemory.project();
      if (currentProjection.compactableTurnCount === 0) {
        return activeRequestController.prepare(messages);
      }
      const prepared = await sessionMemory.prepare(request);
      return Object.freeze({
        messages: replaceSessionMemoryProjection({
          messages,
          current: currentProjection,
          next: prepared.projection,
        }),
        commit: prepared.commit,
        scopeId: `session:${request.sessionId}:history`,
        sourceRevision: prepared.checkpoint.sourceRevision,
        coveredSourceCount: prepared.coveredTurnCount,
      });
    },
  });
}
