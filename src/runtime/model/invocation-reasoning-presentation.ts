import type { ResolvedModelInvocation } from "../../model-gateway/types.js";
import type { InvocationReasoningPresentation } from "../../shared/session-model-selection.js";

/** Copy the resolved controls; omission means provider policy, not disabled thinking. */
export function projectInvocationReasoning(invocation: ResolvedModelInvocation): InvocationReasoningPresentation {
  return {
    ...(invocation.think !== undefined ? { reasoningEffort: invocation.think } : {}),
    ...(invocation.reasoningBudget ? { reasoningBudget: { ...invocation.reasoningBudget } } : {}),
    ...(invocation.reasoningControlSource ? { reasoningControlSource: invocation.reasoningControlSource } : {}),
  };
}
