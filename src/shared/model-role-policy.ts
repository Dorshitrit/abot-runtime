import {
  normalizeModelStepId,
  resolveModelInvocationStep,
} from "./model-step-registry.js";

export function resolveRuntimeModelRole(params: {
  modelStep?: string;
}): string | undefined {
  const step = normalizeModelStepId(params.modelStep);
  const definition = resolveModelInvocationStep(step);
  if (definition) {
    return definition.role;
  }
  if (step.length === 0) {
    return "chat";
  }
  return undefined;
}
