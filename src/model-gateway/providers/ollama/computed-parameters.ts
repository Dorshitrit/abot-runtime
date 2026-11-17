import { resolveModelParameters } from "../../policy/model-parameter-resolution.js";
import type { ModelGatewayRequest, ResolvedModelInvocation } from "../../types.js";
import type { ResolvedModelParameters } from "../../../shared/model-parameters.js";

/** Validate the late provider allowance against the same request-frozen policy. */
export function resolveOllamaComputedParameters(request: ModelGatewayRequest, invocation: ResolvedModelInvocation,
  derivedNumPredict: number): ResolvedModelParameters | undefined {
  if (!invocation.parameters) return undefined;
  const profile = invocation.profile;
  const requestOverride = invocation.reasoningControlSource === "request";
  const resolved = resolveModelParameters({ provider: profile.provider, model: invocation.model,
    generation: profile.generation, options: profile.options, catalog: request.modelPolicy?.parameterProfiles,
    supportsThinking: profile.supportsThinking, computedDefaults: { max_output_tokens: derivedNumPredict },
    effectiveReasoning: { effort: invocation.think,
      budget: invocation.reasoningBudget?.mode === "tokens" ? invocation.reasoningBudget.tokens : undefined,
      overrideEffort: requestOverride || invocation.reasoningControlSource === "invocation", overrideBudget: requestOverride } });
  return { ...resolved, warnings: [...new Map([...invocation.parameters.warnings, ...resolved.warnings]
    .map((warning) => [JSON.stringify(warning), warning])).values()] };
}
