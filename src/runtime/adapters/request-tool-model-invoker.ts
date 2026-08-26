import type { ToolModelInvoker } from "../../capabilities/tool-types.js";
import { invokeRawModelStep } from "../model/invoke-raw-step.js";
import type { BoundRequestModelInvocationContext } from "../request/contracts.js";

/** Binds model-assisted tools to the current request's configured model boundary. */
export function createRequestToolModelInvoker(
  request: BoundRequestModelInvocationContext,
): ToolModelInvoker {
  return Object.freeze({
    invokeText(input) {
      return invokeRawModelStep({
        request,
        modelStep: input.modelStep,
        messages: [
          ...(input.instructions
            ? [{ role: "system" as const, content: input.instructions }]
            : []),
          { role: "user" as const, content: input.prompt },
        ],
        timeoutReason: input.timeoutReason,
        ...(input.format ? { format: input.format } : {}),
      });
    },
  });
}
