import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelStepContextCompactionController } from "../../model/model-step-port.js";
import type { SupervisorMemoryRouting } from "./memory-routing.js";

/** Compact ordinary routing evidence while retaining this activation's exact memory lane. */
export function preserveSupervisorMemoryRoutingContext(
  controller: ModelStepContextCompactionController,
  routing: Pick<SupervisorMemoryRouting, "instructionAppendix" | "context">,
): ModelStepContextCompactionController {
  const appendix = routing.instructionAppendix;
  const reference = routing.context?.message;
  const referenceContent = reference?.content;
  const assertMemoryRoutingContextPreserved = (messages: readonly ChatMessage[]): void => {
    const policy = messages[0];
    if (!appendix || policy?.role !== "system" || policy.content.split(appendix).length !== 2)
      throw new Error("supervisor_memory_routing_context_changed");
    if (!reference) return;
    const matches = messages.filter(message => message === reference ||
      (message.role === reference.role && message.content === referenceContent));
    // The original instance also retains its invocation-local context binding.
    if (matches.length !== 1 || matches[0] !== reference || reference.content !== referenceContent)
      throw new Error("supervisor_memory_routing_context_changed");
  };
  return Object.freeze({
    project(messages) {
      assertMemoryRoutingContextPreserved(messages);
      const projected = controller.project(messages);
      assertMemoryRoutingContextPreserved(projected);
      return projected;
    },
    projectForCompaction(messages) {
      assertMemoryRoutingContextPreserved(messages);
      const projected = controller.projectForCompaction?.(messages) ?? messages;
      assertMemoryRoutingContextPreserved(projected);
      return projected;
    },
    getStages() {
      return Object.freeze(controller.getStages().map(stage => Object.freeze({
        ...stage,
        async prepare(messages: readonly ChatMessage[], context?: Parameters<typeof stage.prepare>[1]) {
          assertMemoryRoutingContextPreserved(messages);
          const outcome = await stage.prepare(messages, {
            ...context,
            ...(context?.canRetainProjection ? {
              canRetainProjection(candidate: readonly ChatMessage[]) {
                assertMemoryRoutingContextPreserved(candidate);
                return context.canRetainProjection!(candidate);
              },
            } : {}),
          });
          if (outcome.kind !== "prepared") return outcome;
          const { preparation } = outcome;
          assertMemoryRoutingContextPreserved(preparation.messages);
          return Object.freeze({ ...outcome, preparation: Object.freeze({
            ...preparation,
            commit() {
              assertMemoryRoutingContextPreserved(preparation.messages);
              return preparation.commit();
            },
          }) });
        },
      })));
    },
    ...(controller.hasExhaustedVerifiedCompactionSources ? {
      hasExhaustedVerifiedCompactionSources(messages: readonly ChatMessage[]) {
        assertMemoryRoutingContextPreserved(messages);
        return controller.hasExhaustedVerifiedCompactionSources!(messages);
      },
    } : {}),
  });
}
