import type { LongTermMemoryRequestContext } from "./contracts.js";

export const LONG_TERM_MEMORY_EVENTS = Object.freeze({
  RETRIEVAL_STARTED: "memory.retrieval.started",
  RETRIEVAL_COMPLETED: "memory.retrieval.completed",
  RETRIEVAL_FAILED: "memory.retrieval.failed",
  SAVE_QUEUED: "memory.save.queued",
});

export function emitLongTermMemoryEvent(params: {
  enabled: boolean;
  context: Pick<LongTermMemoryRequestContext, "onEvent">;
  name: (typeof LONG_TERM_MEMORY_EVENTS)[keyof typeof LONG_TERM_MEMORY_EVENTS];
  details?: Record<string, unknown>;
}): void {
  if (!params.enabled || !params.context.onEvent) {
    return;
  }
  params.context.onEvent(params.name, {
    stage: "long_term_memory",
    ...params.details,
  });
}
