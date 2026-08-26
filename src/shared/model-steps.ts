import {
  isRegisteredModelStepInLane,
  MODEL_INVOCATION_STEP_REGISTRY,
  type ModelInvocationStepKey,
  type ModelStep,
} from "./model-step-registry.js";

export const MODEL_STEPS = Object.freeze(
  Object.fromEntries(
    Object.entries(MODEL_INVOCATION_STEP_REGISTRY).map(([key, definition]) => [
      key,
      definition.id,
    ]),
  ),
) as {
  readonly [Key in ModelInvocationStepKey]: (typeof MODEL_INVOCATION_STEP_REGISTRY)[Key]["id"];
};

export type { ModelStep } from "./model-step-registry.js";

export function isMainModelStep(modelStep: unknown): boolean {
  const step = typeof modelStep === "string" ? modelStep.trim() : "";
  return step.length === 0 || isRegisteredModelStepInLane(step, "main");
}

export function isFastModelStep(modelStep: unknown): boolean {
  return isRegisteredModelStepInLane(modelStep, "fast");
}
