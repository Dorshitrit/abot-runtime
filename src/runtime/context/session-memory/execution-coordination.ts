import { createCompactionProgressFanout } from "../../model/context-compaction-progress.js";
import type { ChatMessage } from "../../../model-gateway/types.js";
import { isExecutionSessionMemoryScope } from "../../../sessions/memory/checkpoint-scope.js";
import type { ModelStepContextCompactionController } from "../../model/model-step-port.js";
import type { PreparedSessionMemoryCheckpoint, RequestSessionMemory } from "./contracts.js";
import { replaceSessionMemoryProjection } from "./message-replacement.js";

/** Parallel EA payload authors share one history candidate and its exact CAS outcome. */
export function coordinateExecutionSessionMemory(memory: RequestSessionMemory): RequestSessionMemory {
  if (!hasExecutionScope(memory)) return memory;
  let pending: Promise<PreparedSessionMemoryCheckpoint> | undefined;
  const progress = createCompactionProgressFanout();
  return Object.freeze({
    snapshot: () => memory.snapshot!(),
    project: () => memory.project(),
    prepare(request: Parameters<RequestSessionMemory["prepare"]>[0], onProgress?: Parameters<RequestSessionMemory["prepare"]>[1]) {
      progress.add(onProgress);
      if (pending) return pending;
      const preparation = memory.prepare(request, progress.report).then((prepared) => {
        let commit: Promise<void> | undefined;
        return Object.freeze({
          ...prepared,
          commit() {
            commit ??= prepared.commit().finally(() => {
              if (pending !== preparation) return;
              pending = undefined;
              progress.clear();
            });
            return commit;
          },
        });
      });
      pending = preparation;
      void preparation.catch(() => {
        if (pending !== preparation) return;
        pending = undefined;
        progress.clear();
      });
      return preparation;
    },
  });
}

/** Refresh only committed history when a peer advances it during token counting. */
export function coordinateExecutionHistoryProjection(
  memory: RequestSessionMemory,
  controller: ModelStepContextCompactionController,
): ModelStepContextCompactionController {
  if (!hasExecutionScope(memory)) return controller;
  let represented = memory.project();
  function refresh(messages: readonly ChatMessage[]): readonly ChatMessage[] {
    const current = memory.project();
    if (represented.checkpointRevision === current.checkpointRevision) return messages;
    const projected = replaceSessionMemoryProjection({ messages, current: represented, next: current });
    represented = current;
    return projected;
  }
  return Object.freeze({
    ...controller,
    project(messages: readonly ChatMessage[]) {
      represented = memory.project();
      return controller.project(messages);
    },
    projectForCompaction: refresh,
    getStages() {
      const coveredSourceCount = memory.project().compactableTurnCount;
      return controller.getStages().map((stage) => stage.compactionScope !== "session_history" ? stage : Object.freeze({
        ...stage,
        async prepare(messages: readonly ChatMessage[], context: Parameters<typeof stage.prepare>[1]) {
          const current = memory.project();
          if (current.compactableTurnCount > 0) return stage.prepare(messages, context);
          return Object.freeze({
            kind: "prepared" as const,
            preparation: Object.freeze({
              messages: refresh(messages),
              scopeId: stage.scopeId,
              sourceRevision: current.sourceRevision,
              coveredSourceCount,
              hasExhaustedCompactionSources: true,
              commit: async () => {},
            }),
          });
        },
      }));
    },
  });
}

function hasExecutionScope(memory: RequestSessionMemory): boolean {
  return isExecutionSessionMemoryScope(memory.snapshot?.().source.scope);
}
