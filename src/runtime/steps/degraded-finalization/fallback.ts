import type { DegradedFinalizationInput } from "./contract.js";
import { renderDegradedFinalization } from "./render.js";

export function buildDegradedFinalizationFallback(
  input: DegradedFinalizationInput,
): string {
  return renderDegradedFinalization({
    input,
    phrasing: {
      failureNotice:
        "I couldn't complete this request because the runtime reached a terminal state it could not safely recover from.",
      nextStep: "You can retry or continue the request in a follow-up message.",
    },
  });
}
