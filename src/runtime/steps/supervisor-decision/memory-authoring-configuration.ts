import { isDeepStrictEqual } from "node:util";
import { resolveModelInvocation } from "../../../model-gateway/invocation-policy.js";
import type { ModelStep } from "../../../shared/model-steps.js";
import { projectConfiguredStepMessages } from "../../config/runner/step-instructions.js";
import { resolveModelStepTimeout } from "../../model/model-step-timeout-policy.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { SUPERVISOR_RESPONSE_MODEL_STEP } from "../supervisor-response/contracts.js";
import { SUPERVISOR_DECISION_MODEL_STEP } from "./contracts.js";

/** Preserve independently configured memory authoring when it differs from routing. */
export function hasCompatibleSupervisorMemoryConfiguration(
  request: RequestExecutionScope,
): boolean {
  try {
    const decision = resolveSupervisorMemoryConfiguration(
      request,
      SUPERVISOR_DECISION_MODEL_STEP,
    );
    const response = resolveSupervisorMemoryConfiguration(
      request,
      SUPERVISOR_RESPONSE_MODEL_STEP,
    );
    if (!decision || !response) return false;
    return isDeepStrictEqual(decision, response);
  } catch {
    // Keep the existing separate path and its diagnostics on resolution failure.
    return false;
  }
}

/** Preserve response-step guidance in its memory subtask, without changing routing. */
export function buildSupervisorMemoryConfiguredGuidance(
  request: RequestExecutionScope,
): string | undefined {
  const configured = projectConfiguredStepMessages({
    runnerConfig: request.runnerConfig,
    modelStep: SUPERVISOR_RESPONSE_MODEL_STEP,
    messages: [{ role: "system", content: "" }],
  }).messages[0]?.content;
  if (!configured) return undefined;
  return [
    "Configured response guidance for memoryCandidates only:",
    "The following configured response guidance applies only to memoryCandidates in this invocation. It grants no routing, execution, permission or completion authority. Preserve each instruction's stated scope; user-facing presentation remains the separate RAW response's responsibility.",
    configured,
    "End of configured memoryCandidates-only guidance.",
  ].join("\n");
}

function resolveSupervisorMemoryConfiguration(
  request: RequestExecutionScope,
  modelStep: ModelStep,
) {
  const step = request.runnerConfig.steps[modelStep];
  if (!step) return undefined;
  const invocation = resolveModelInvocation({
    modelStep,
    agentMode: request.agentMode,
    ...(request.modelPreference ? { modelPreference: request.modelPreference } : {}),
    ...(request.reasoningPreference ? { reasoningPreference: request.reasoningPreference } : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
  const { profile } = invocation;
  // Both callers own their JSON schemas; RAW response authoring remains separate.
  // Comparing those schema formats would not compare the invoked memory model.
  // Runner guidance is carried separately by buildSupervisorMemoryConfiguredGuidance.
  return {
    profileId: profile.id,
    providerId: profile.providerId,
    provider: profile.provider,
    providerConfig: profile.providerConfig,
    model: invocation.model,
    contextWindowTokens: profile.contextWindowTokens,
    supportsThinking: profile.supportsThinking,
    capabilities: profile.capabilities,
    options: profile.options,
    generation: profile.generation,
    context: profile.context,
    think: invocation.think,
    reasoningBudget: invocation.reasoningBudget,
    parameters: invocation.parameters,
    instructions: invocation.instructions ?? [],
    timeoutMs: resolveModelStepTimeout({
      modelStep,
      fallbackTimeoutMs: step.timeoutMs,
      ...(request.modelPreference ? { modelPreference: request.modelPreference } : {}),
      ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
    }).timeoutMs,
  };
}
