import { isDeepStrictEqual } from "node:util";
import { resolveModelInvocation } from "../../../model-gateway/invocation-policy.js";
import type { ModelStep } from "../../../shared/model-steps.js";
import { resolveModelStepTimeout } from "../../model/model-step-timeout-policy.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import {
  EXECUTION_AGENT_DECISION_MODEL_STEP,
  EXECUTION_AGENT_RESPONSE_MODEL_STEP,
} from "./contracts.js";

/** Preserve a separately configured response model/calibration instead of silently bypassing it. */
export function hasCompatibleDirectResponseConfiguration(
  request: RequestExecutionScope,
): boolean {
  try {
    const decision = effectiveConfiguration(
      request,
      EXECUTION_AGENT_DECISION_MODEL_STEP,
    );
    const response = effectiveConfiguration(
      request,
      EXECUTION_AGENT_RESPONSE_MODEL_STEP,
    );
    if (!decision || !response) return false;
    return isDeepStrictEqual(decision, response);
  } catch {
    // Resolution failures keep the existing deferred path and its diagnostics.
    return false;
  }
}

function effectiveConfiguration(
  request: RequestExecutionScope,
  modelStep: ModelStep,
) {
  const step = request.runnerConfig.steps[modelStep];
  if (!step) return undefined;
  const invocation = resolveModelInvocation({
    modelStep,
    agentMode: request.agentMode,
    ...(request.modelPreference
      ? { modelPreference: request.modelPreference }
      : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
  if (hasSpecialResponseFormat(modelStep, invocation.format)) return undefined;
  const { profile } = invocation;
  return {
    profileId: profile.id,
    providerId: profile.providerId,
    provider: profile.provider,
    model: profile.model,
    contextWindowTokens: profile.contextWindowTokens,
    capabilities: profile.capabilities,
    options: profile.options,
    generation: profile.generation,
    context: profile.context,
    think: invocation.think,
    instructions: invocation.instructions ?? [],
    timeoutMs: resolveModelStepTimeout({
      modelStep,
      fallbackTimeoutMs: step.timeoutMs,
      ...(request.modelPreference
        ? { modelPreference: request.modelPreference }
        : {}),
      ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
    }).timeoutMs,
  };
}

function hasSpecialResponseFormat(
  modelStep: ModelStep,
  format: unknown,
): boolean {
  if (modelStep !== EXECUTION_AGENT_RESPONSE_MODEL_STEP) return false;
  if (format === undefined) return false;
  if (format && typeof format === "object" && "type" in format)
    return format.type !== "text";
  return true;
}
