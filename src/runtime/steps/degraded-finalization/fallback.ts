import type {
  DegradedFinalizationInput,
  DegradedFinalizationPhrasing,
} from "./contract.js";
import { renderDegradedFinalization } from "./render.js";
import { hasModelOutputLimitCause } from "./output-limit-cause.js";

export function buildDegradedFinalizationFallback(
  input: DegradedFinalizationInput,
): string {
  return renderDegradedFinalization({
    input,
    phrasing: resolveFallbackPhrasing(input),
  });
}

function resolveFallbackPhrasing(
  input: DegradedFinalizationInput,
): DegradedFinalizationPhrasing {
  if (hasModelOutputLimitCause(input.problem)) {
    return {
      failureNotice:
        "The model reached its output-token limit before finishing its next decision or response.",
      nextStep:
        "Review the selected model and reasoning settings before continuing.",
    };
  }
  return {
    failureNotice:
      "I couldn't complete this request because the runtime reached a terminal state it could not safely recover from.",
    nextStep: "You can retry or continue the request in a follow-up message.",
  };
}
