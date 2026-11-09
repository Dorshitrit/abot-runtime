import type {
  ModelInvocationLane,
  ModelInvocationStepDefinition,
} from "./model-step-registry.types.js";
import { GENERATED_MODEL_INVOCATION_STEP_REGISTRY } from "./model-step-registry.generated.js";

export type {
  ModelInvocationFormat,
  ModelInvocationAttachmentPolicy,
  ModelInvocationLane,
  ModelInvocationRole,
  ModelInvocationStepDefinition,
  ModelInvocationStepOwner,
  RegisteredModelInvocationStepDefinition,
} from "./model-step-registry.types.js";

export const MODEL_INVOCATION_STEP_REGISTRY =
  GENERATED_MODEL_INVOCATION_STEP_REGISTRY;

export type ModelInvocationStepKey =
  keyof typeof MODEL_INVOCATION_STEP_REGISTRY;

export type ModelStep =
  (typeof MODEL_INVOCATION_STEP_REGISTRY)[ModelInvocationStepKey]["id"];

export const MODEL_INVOCATION_STEP_DEFINITIONS = Object.freeze(
  Object.entries(MODEL_INVOCATION_STEP_REGISTRY).map(([key, definition]) => ({
    key: key as ModelInvocationStepKey,
    ...definition,
  })),
) as readonly ModelInvocationStepDefinition[];

const MODEL_STEP_BY_ID = new Map<string, ModelInvocationStepDefinition>(
  MODEL_INVOCATION_STEP_DEFINITIONS.map((definition) => [
    definition.id,
    definition,
  ]),
);

export function normalizeModelStepId(modelStep: unknown): string {
  return typeof modelStep === "string" ? modelStep.trim() : "";
}

export function resolveModelInvocationStep(
  modelStep: unknown,
): ModelInvocationStepDefinition | undefined {
  const id = normalizeModelStepId(modelStep);
  if (!id) {
    return undefined;
  }

  const exact = MODEL_STEP_BY_ID.get(id);
  if (exact) {
    return exact;
  }

  return undefined;
}

export function isRegisteredModelStepInLane(
  modelStep: unknown,
  lane: ModelInvocationLane,
): boolean {
  const id = normalizeModelStepId(modelStep);
  const exact = id ? MODEL_STEP_BY_ID.get(id) : undefined;
  return exact?.lane === lane;
}
