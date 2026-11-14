import {
  BOUND_REQUEST_MODEL_INVOCATION,
  type BoundRequestModelInvocationContext,
  type RequestModelInvocationView,
} from "../request/contracts.js";
import { RequestModelStepInvoker } from "./invoke-step.js";

/** Shared binding for chat and command runs; neither caller creates a second model loop. */
export function bindModelInvocation(
  view: RequestModelInvocationView,
  onEvent?: (name: string, extra?: Record<string, unknown>) => void,
): BoundRequestModelInvocationContext {
  const context = {
    ...view,
    modelSteps: Object.freeze(new RequestModelStepInvoker(view, onEvent)),
  };
  Object.defineProperty(context, BOUND_REQUEST_MODEL_INVOCATION, {
    value: true,
  });
  return Object.freeze(context) as BoundRequestModelInvocationContext;
}
